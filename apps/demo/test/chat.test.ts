import { describe, expect, it } from 'vitest'
import { Scene, Story } from '@foldkit-native/core'
import * as Chat from '../src/chat/model'
import { chatView } from '../src/chat/view'
import { parseBlocks, parseSpans } from '../src/chat/markdown'

/**
 * The chat's tests, in the two styles the framework ships, plus the markdown
 * parser.
 *
 * What matters most here is a single invariant, asserted three times over. The
 * subscription restarts when its dependency changes, and its dependency is the
 * request. If a token changed the request, every token would restart the stream and
 * a reply would never finish - and nothing in a type check or a unit test would
 * ever have said so. It is the kind of bug only a test about *timing of the
 * loop* catches.
 */

type Model = Chat.ChatModel
type Message = Chat.ChatMessage

const M = Chat.ChatMessageUnion

/** The request the Model wants answered, or null when nothing is in flight. */
const request = (model: Model): Chat.ChatRequest | null => {
  const raw = Chat.activeRequest(model)
  return raw === '' ? null : (JSON.parse(raw) as Chat.ChatRequest)
}

/**
 * Folds the chat up to "a turn is in flight", and stops.
 *
 * Built out of Story rather than a hand-written literal so the fixture cannot drift
 * from what the application actually does to get here - a literal that says
 * `status: 'streaming'` is a claim about the Model, not a fact about it.
 */
const afterSend = (text: string, draft = text): Model =>
  Story.story<Model, Message>(
    Chat.update,
    Story.given(Chat.init),
    Story.message(M.StartedNewChat()),
    Story.message(M.ChangedDraft({ draft })),
    Story.message(M.ClickedSend()),
  ).model

/** The assistant entry of the conversation `afterSend` left in flight. */
const assistant = (model: Model): Chat.ChatEntry => {
  const entry = model.conversations[0]?.messages[1]
  if (entry === undefined) throw new Error('no assistant entry')
  return entry
}

const say = (model: Model, ...delta: string[]): Model =>
  delta.reduce((current, text) => Chat.update(current, M.ReceivedTextDelta({ delta: text })).model, model)

// --- THE REQUEST ------------------------------------------------------------

describe('the request the chat is asking', () => {
  it('is empty until something is sent, and empty again once the reply is whole', () => {
    const model = afterSend('What is Nitro?')
    expect(Chat.activeRequest(model)).not.toBe('')

    const done = Chat.update(model, M.CompletedTurn()).model
    expect(Chat.activeRequest(done)).toBe('')
  })

  /**
   * The property the whole streaming design rests on.
   *
   * `activeRequest` omits the in-flight reply, so a token cannot change the request.
   * Were that not true, every token would restart the stream it is arriving on.
   */
  it('does not change when a token arrives, or the stream would restart on every one', () => {
    const model = afterSend('What is Nitro?')
    const before = Chat.activeRequest(model)
    const streamed = say(model, 'Nitro ', 'is ', 'a native module system.')

    expect(Chat.activeRequest(streamed)).toBe(before)
    expect(assistant(streamed).text).toBe('Nitro is a native module system.')
  })

  it('does not change when the reasoning streams either', () => {
    const model = afterSend('What is Nitro?')
    const before = Chat.activeRequest(model)
    const thought = Chat.update(model, M.ReceivedReasoningDelta({ delta: 'The user asks about a library.' })).model
    expect(Chat.activeRequest(thought)).toBe(before)
  })

  it('stops the request when the user stops the turn, which is what ends the generation', () => {
    const model = afterSend('Write me a long story')
    const stopped = Chat.update(model, M.ClickedStop()).model
    expect(Chat.activeRequest(stopped)).toBe('')
    expect(assistant(stopped).status).toBe('cancelled')
  })

  it('puts the question in the request, but never the reply being written', () => {
    const asked = request(say(afterSend('What is Nitro?'), 'It is a '))
    expect(asked?.messages).toHaveLength(1)
    expect(asked?.messages[0]).toEqual({ role: 'user', content: 'What is Nitro?' })
    expect(asked?.system).toContain('on the user')
  })

  it('carries earlier turns over as history', () => {
    const first = Chat.update(afterSend('What is Nitro?'), M.CompletedTurn()).model
    const second = Story.story<Model, Message>(
      Chat.update,
      Story.given(first),
      Story.message(M.ChangedDraft({ draft: 'And who writes it?' })),
      Story.message(M.ClickedSend()),
    ).model

    expect(request(second)?.messages.map((entry) => entry.content)).toEqual([
      'What is Nitro?',
      'And who writes it?',
    ])
  })

  it('keeps the window inside what the model can hold, oldest first', () => {
    // Enough long turns to genuinely overflow the budget: 26 turns of ~660
    // characters is ~17,000, well past the ~12,000 the app allows. Short questions
    // would fit many times over and would pass whether or not trimming worked.
    const padding = ' with a good deal of padding so that this turn is a realistic length to send'
    let model = afterSend(`first question${padding.repeat(8)}`)

    for (let index = 0; index < 25; index += 1) {
      model = Story.story<Model, Message>(
        Chat.update,
        Story.given(Chat.update(model, M.CompletedTurn()).model),
        Story.message(M.ChangedDraft({ draft: `question number ${index}${padding.repeat(8)}` })),
        Story.message(M.ClickedSend()),
      ).model
    }

    const asked = request(model)
    expect(asked).not.toBeNull()
    // The newest turn is the one being answered, so it must survive; the oldest is
    // what gets spent.
    expect(asked!.messages.at(-1)?.content).toContain('question number 24')
    expect(asked!.messages.some((entry) => entry.content.includes('first question'))).toBe(false)
    // No empty turn: a budget that hits zero must stop the walk, not add a blank.
    expect(asked!.messages.every((entry) => entry.content.length > 0)).toBe(true)
  })
})

// --- THE STATE MACHINE ------------------------------------------------------

describe('the chat state machine', () => {
  it('appends the question and an empty assistant entry, streaming', () => {
    const model = afterSend('What is Nitro?')
    const messages = model.conversations[0]?.messages ?? []

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', text: 'What is Nitro?', status: 'done' })
    expect(messages[1]).toMatchObject({ role: 'assistant', text: '', status: 'streaming' })
    expect(model.draft).toBe('')
  })

  it('names the conversation after what was said', () => {
    expect(afterSend('What is Nitro Modules?').conversations[0]?.title).toBe('What is Nitro Modules?')
  })

  it('truncates a long title rather than letting it wrap over three lines', () => {
    const title = afterSend('x'.repeat(80)).conversations[0]?.title
    expect(title?.length).toBeLessThanOrEqual(43)
    expect(title?.endsWith('…')).toBe(true)
  })

  it('refuses to send nothing', () => {
    const started = Story.story<Model, Message>(
      Chat.update,
      Story.given(Chat.init),
      Story.message(M.StartedNewChat()),
    ).model
    expect(Chat.update(started, M.ClickedSend()).model.conversations[0]?.messages).toHaveLength(0)
  })

  it('sends a photo with no words at all', () => {
    const started = Story.story<Model, Message>(
      Chat.update,
      Story.given(Chat.init),
      Story.message(M.StartedNewChat()),
      Story.message(M.PickedAttachment({ uri: 'file://a.png', width: 10, height: 10 })),
      Story.message(M.ClickedSend()),
    ).model
    expect(started.conversations[0]?.messages[0]).toMatchObject({ text: '', status: 'done' })
    expect(started.conversations[0]?.messages[0]?.attachments).toHaveLength(1)
  })

  it('ends the turn when the stream completes', () => {
    const streamed = say(afterSend('What is Nitro?'), 'Nitro is a module system.')
    expect(assistant(Chat.update(streamed, M.CompletedTurn()).model).status).toBe('done')
  })

  it('keeps text that arrived before a failure', () => {
    const streamed = say(afterSend('Write a poem'), 'Roses are ')
    const failed = Chat.update(streamed, M.FailedTurn({ reason: 'the model gave up' })).model

    expect(assistant(failed).text).toBe('Roses are ')
    expect(assistant(failed).status).toBe('failed')
  })

  it('shows the reason when a failure arrives before any text at all', () => {
    const failed = Chat.update(afterSend('Write a poem'), M.FailedTurn({ reason: 'Apple Intelligence is off' })).model
    expect(assistant(failed).text).toBe('⚠ Apple Intelligence is off')
  })

  it('stops the turn even when a failure arrives with no text to keep', () => {
    const failed = Chat.update(afterSend('Write a poem'), M.FailedTurn({ reason: 'nope' })).model
    expect(Chat.activeRequest(failed)).toBe('')
  })

  it('opens the thought trace only for an entry that has one', () => {
    const withThought = Chat.update(afterSend('What is Nitro?'), M.ReceivedReasoningDelta({ delta: 'Thinking.' })).model
    const id = assistant(withThought).id

    expect(Chat.update(withThought, M.OpenedReasoning({ id })).model.reasoningFor).toBe(id)
    // A user entry has no trace, so tapping one must not open an empty sheet.
    expect(Chat.update(withThought, M.OpenedReasoning({ id: 'm1' })).model.reasoningFor).toBe('')
  })

  it('refuses a link that is not http', () => {
    Story.story<Model, Message>(
      Chat.update,
      Story.given(afterSend('run this')),
      Story.message(M.ClickedLink({ url: 'javascript:alert(1)' })),
      Story.Command.expect(Chat.OpenLink),
      Story.Command.resolve(Chat.OpenLink, M.FailedToOpenLink({ url: 'javascript:alert(1)' })),
      Story.model((model) => expect(model.notice).toContain('cannot be opened')),
    )
  })

  it('ignores a tap for a conversation that is not there', () => {
    const model = afterSend('What is Nitro?')
    expect(Chat.update(model, M.OpenedConversation({ conversationId: 'nope' })).model).toEqual(model)
  })

  it('never mutates the Model it was given', () => {
    const before = afterSend('What is Nitro?')
    const snapshot = JSON.stringify(before)

    Chat.update(before, M.ReceivedTextDelta({ delta: 'x' }))
    Chat.update(before, M.ReceivedReasoningDelta({ delta: 'x' }))
    Chat.update(before, M.ClickedStop())
    Chat.update(before, M.ClickedSend())
    Chat.update(before, M.CompletedTurn())

    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

// --- THE SCREEN -------------------------------------------------------------

describe('the chat screen', () => {
  const program = { update: Chat.update, view: chatView }

  it('opens on the chat list, empty', () => {
    Scene.scene(program, Scene.given(Chat.init), Scene.expect(Scene.testId('recents-empty')))
  })

  it('walks from the list into a chat and back', () => {
    Scene.scene(
      program,
      Scene.given(Chat.init),
      Scene.click(Scene.role('button', { name: 'New chat' })),
      Scene.expect(Scene.testId('chat')),
      Scene.click(Scene.role('button', { name: 'Back to chats' })),
      Scene.expect(Scene.testId('recents')),
    )
  })

  it('shows the question and a thinking indicator while the reply streams', () => {
    Scene.scene(
      program,
      Scene.given(Chat.init),
      Scene.click(Scene.role('button', { name: 'New chat' })),
      Scene.type(Scene.label('Message'), 'What is Nitro?'),
      Scene.click(Scene.role('button', { name: 'Send' })),
      Scene.expectText('What is Nitro?'),
      Scene.expect(Scene.testId('thinking')),
    )
  })

  it('offers Stop instead of Send while a turn is in flight', () => {
    Scene.scene(
      program,
      Scene.given(afterSend('What is Nitro?')),
      Scene.expect(Scene.role('button', { name: 'Stop generating' })),
      Scene.expectNot(Scene.role('button', { name: 'Send' })),
    )
  })

  it('replaces the thinking row with the reply as it arrives', () => {
    Scene.scene(
      program,
      Scene.given(afterSend('What is Nitro?')),
      Scene.message(M.ReceivedTextDelta({ delta: 'Nitro is a native module system.' })),
      Scene.expectText('Nitro is a native module system.'),
      Scene.expectNot(Scene.testId('thinking')),
    )
  })

  it('says a stopped turn was stopped, rather than leaving it thinking forever', () => {
    Scene.scene(
      program,
      Scene.given(afterSend('Write me a long story')),
      Scene.click(Scene.role('button', { name: 'Stop generating' })),
      Scene.expectText('Stopped'),
    )
  })

  it('shows the reason when the model could not run at all', () => {
    Scene.scene(
      program,
      Scene.given(afterSend('What is Nitro?')),
      Scene.message(M.FailedTurn({ reason: 'Apple Intelligence is not available on this device.' })),
      Scene.expectText('⚠ Apple Intelligence is not available on this device.'),
      Scene.expect(Scene.role('button', { name: 'Send' })),
    )
  })

  it('opens and closes the thought trace', () => {
    const withThought = Chat.update(
      afterSend('What is Nitro?'),
      M.ReceivedReasoningDelta({ delta: 'Nitro is a library, let me think about it.' }),
    ).model

    Scene.scene(
      program,
      Scene.given(withThought),
      Scene.click(Scene.role('button', { name: 'Show thought process' })),
      Scene.expect(Scene.testId('reasoning-sheet')),
      Scene.expectText('Nitro is a library, let me think about it.'),
      Scene.click(Scene.role('button', { name: 'Close thought process' })),
      Scene.expectNot(Scene.testId('reasoning-sheet')),
    )
  })

  it('lists a finished chat on the recents screen by what was asked', () => {
    const finished = Chat.update(say(afterSend('What is Nitro Modules?'), 'A module system.'), M.CompletedTurn()).model

    Scene.scene(
      program,
      Scene.given(finished),
      Scene.click(Scene.role('button', { name: 'Back to chats' })),
      Scene.expect(Scene.role('button', { name: 'Open What is Nitro Modules?' })),
    )
  })

  it('renders a reply with headings, lists and code', () => {
    const streamed = say(
      afterSend('Show me a list'),
      '# Margelo\n\n- one\n- two\n\n```ts\nconst a = 1\n```',
    )

    Scene.scene(
      program,
      Scene.given(streamed),
      Scene.expect(Scene.testId('md-h1')),
      Scene.expect(Scene.testId('md-code')),
      Scene.expectText('one'),
    )
  })
})

// --- MARKDOWN ---------------------------------------------------------------

describe('markdown', () => {
  it('reads headings, lists and code out of a reply', () => {
    const blocks = parseBlocks('# Title\n\nSome text.\n\n- one\n- two\n\n```ts\nconst a = 1\n```')
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'bullet', 'code'])
  })

  it('does not let a paragraph swallow the list that follows it', () => {
    const blocks = parseBlocks('Here you go:\n- one\n- two')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'bullet'])
  })

  it('closes an unterminated code fence instead of losing the rest of the reply', () => {
    const blocks = parseBlocks('before\n\n```py\nprint(1)')
    expect(blocks[1]).toMatchObject({ kind: 'code', language: 'py', text: 'print(1)' })
  })

  it('reads the four inline spans', () => {
    expect(parseSpans('a **b** c *d* `e` [f](https://x.dev)')).toEqual([
      { kind: 'plain', text: 'a ' },
      { kind: 'bold', text: 'b' },
      { kind: 'plain', text: ' c ' },
      { kind: 'italic', text: 'd' },
      { kind: 'plain', text: ' ' },
      { kind: 'code', text: 'e' },
      { kind: 'plain', text: ' ' },
      { kind: 'link', text: 'f', url: 'https://x.dev' },
    ])
  })

  it('leaves a lone asterisk as the character the user wrote', () => {
    expect(parseSpans('2 * 3 = 6')).toEqual([{ kind: 'plain', text: '2 * 3 = 6' }])
  })
})
