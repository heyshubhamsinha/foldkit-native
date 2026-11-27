/**
 * The chat: one Model, one pure `update`, one view.
 *
 * This is the Todo list grown into the thing the Todo list was a proof of: a
 * conversation that streams token by token, can be stopped mid-sentence, and is one
 * immutable value from the first tap to the last token.
 *
 * ## What drives the streaming
 *
 * A subscription, whose single dependency is the request the Model says it wants
 * answered. That one string encodes every transition:
 *
 * - A token arrives and the request does **not** change, so the stream is not
 *   restarted. That is why {@link activeRequest} leaves the in-flight reply's
 *   partial text out. Were it included, every token would restart the stream and
 *   nothing would ever finish.
 * - The turn ends and the request goes back to empty, which stops the socket.
 * - Sending the next message changes it, which starts the next turn.
 *
 * There is no "is streaming" flag anywhere. `status: 'streaming'` on an entry *is*
 * that flag, and everything that depends on it is derived from the request rather
 * than stored beside it.
 */

import { Effect, Option, Schema } from 'effect'
import { Command, Update, defineMessageUnion, modifyFields } from '@foldkit-native/core'

// --- MODEL ------------------------------------------------------------------

/** Which screen is on. Navigation is Model state, not a router outside it. */
export const Screen = Schema.Literals(['recents', 'chat'])
export type Screen = typeof Screen.Type

export const Attachment = Schema.Struct({
  id: Schema.String,
  uri: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
})
export type Attachment = typeof Attachment.Type

/**
 * One entry in the conversation.
 *
 * Named `ChatEntry` rather than `ChatMessage` because `ChatMessage` is the union of
 * facts below, and a Model whose rows and its events share a name is a Model where
 * `ChatMessage` means something different on either side of the `match`.
 */
export const ChatEntry = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(['user', 'assistant']),
  text: Schema.String,
  /** The thought trace, shown behind a disclosure. Empty for a user entry. */
  reasoning: Schema.String,
  /**
   * `streaming` until the reply is whole. `cancelled` is its own state rather than
   * a flag: a stopped turn and a finished one look identical from the model, and
   * only the Model knows which happened.
   */
  status: Schema.Literals(['streaming', 'done', 'failed', 'cancelled']),
  attachments: Schema.Array(Attachment),
})
export type ChatEntry = typeof ChatEntry.Type

export const Conversation = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  messages: Schema.Array(ChatEntry),
  updatedAt: Schema.Number,
})
export type Conversation = typeof Conversation.Type

export const ChatModel = Schema.Struct({
  screen: Screen,
  activeConversationId: Schema.String,
  conversations: Schema.Array(Conversation),
  draft: Schema.String,
  /** Picked but not yet sent - they belong to the next message, not the last. */
  attachments: Schema.Array(Attachment),
  isPickingAttachment: Schema.Boolean,
  /** The entry whose reasoning sheet is open. Empty means none. */
  reasoningFor: Schema.String,
  /**
   * A one-line thing the user should know that belongs to no message - a link that
   * could not be opened, mostly. It is Model state rather than a toast because there
   * is nowhere else in this architecture for it to live, and a `console.log` is not
   * something a user can be shown.
   */
  notice: Schema.String,
  nextId: Schema.Number,
})
export type ChatModel = typeof ChatModel.Type

// --- MESSAGES ---------------------------------------------------------------

export const ChatMessageUnion = defineMessageUnion({
  ChangedDraft: { draft: Schema.String },
  ClickedSend: {},
  /** The user stopped a turn. The only Message that cancels anything. */
  ClickedStop: {},

  // The original app opened a menu of attachment kinds, all but one of which were
  // stubs behind a "demo only" alert. One working kind is a button, not a menu.
  ClickedAddPhoto: {},
  PickedAttachment: { uri: Schema.String, width: Schema.Number, height: Schema.Number },
  DismissedAttachmentPicker: {},
  RemovedAttachment: { id: Schema.String },

  OpenedRecents: {},
  OpenedConversation: { conversationId: Schema.String },
  StartedNewChat: {},

  /** A link in a reply was tapped. The Model decides what opening it means. */
  ClickedLink: { url: Schema.String },
  OpenedLink: { url: Schema.String },
  FailedToOpenLink: { url: Schema.String },
  DismissedNotice: {},

  /** Opens the thought trace behind a reply. The id, so a stale tap is a no-op. */
  OpenedReasoning: { id: Schema.String },
  DismissedReasoning: {},

  ReceivedReasoningDelta: { delta: Schema.String },
  ReceivedTextDelta: { delta: Schema.String },
  CompletedTurn: {},
  FailedTurn: { reason: Schema.String },
})
export type ChatMessage = typeof ChatMessageUnion.Type

// --- COMMANDS ---------------------------------------------------------------

/**
 * Opens the system photo picker.
 *
 * The import is inside `execute` rather than at the top of the file on purpose:
 * this module is imported by every Story and Scene test, and pulling
 * `expo-image-picker` in through the module graph would drag React Native with it
 * into a Node test runner. A Command's body only runs on a device, which is the
 * only place the picker exists.
 *
 * `execute` is the Effect itself and not a function of no arguments: that is the
 * shape a Command with no `args` takes.
 */
export const PickImage = Command.define('PickImage', {
  messages: [ChatMessageUnion.PickedAttachment, ChatMessageUnion.DismissedAttachmentPicker],
  execute: Effect.promise(async () => {
    const Picker = await import('expo-image-picker')
    const permission = await Picker.requestMediaLibraryPermissionsAsync()
    if (!permission.granted) return ChatMessageUnion.DismissedAttachmentPicker()

    const result = await Picker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.5,
      allowsEditing: false,
    })
    if (result.canceled) return ChatMessageUnion.DismissedAttachmentPicker()

    const asset = result.assets[0]
    // A picker that returns no asset is a fact too, and treating it as one is what
    // stops an empty result becoming a message with no image on it.
    if (asset === undefined) return ChatMessageUnion.DismissedAttachmentPicker()
    return ChatMessageUnion.PickedAttachment({
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
    })
  }),
})

/** The two ways opening a link can turn out. */
type LinkOutcome = Extract<ChatMessage, { readonly _tag: 'OpenedLink' | 'FailedToOpenLink' }>

/**
 * Hands a tapped link to the operating system.
 *
 * The scheme is checked here rather than passed through, because the Model is the
 * only place that gets to decide that. `javascript:`, `data:` and `file:` are all
 * things a model can emit inside a reply, and all of them are things that should
 * never reach the OS from a tap the user did not mean as a command.
 *
 * Both outcomes are Messages because a Command's Effect has to produce one of the
 * messages it declared - there is no "succeeded, nothing to report" - so success is
 * a fact too. The arm below it changes nothing, which is the correct handling of a
 * fact that needs no state.
 */
export const OpenLink = Command.define('OpenLink', {
  args: { url: Schema.String },
  messages: [ChatMessageUnion.OpenedLink, ChatMessageUnion.FailedToOpenLink],
  // Annotated because `execute` has two outcomes, and leaving it to inference makes
  // TypeScript read the declared message list from the first branch and reject the
  // second.
  execute: ({ url }): Effect.Effect<LinkOutcome, never, never> =>
    Effect.suspend((): Effect.Effect<LinkOutcome, never, never> =>
      !/^https?:\/\/\S+$/i.test(url)
        ? Effect.succeed(ChatMessageUnion.FailedToOpenLink({ url }))
        : Effect.flatMap(
            Effect.promise(async () => {
              const { Linking } = await import('react-native')
              await Linking.openURL(url)
            }),
            () => Effect.succeed(ChatMessageUnion.OpenedLink({ url })),
          ),
    ),
})

// --- UPDATE -----------------------------------------------------------------

type UpdateReturn = Update.Return<ChatModel, ChatMessage>

/** The assistant entry currently being written to, if any. */
export const inFlight = (model: ChatModel): Option.Option<ChatEntry> => {
  const conversation = activeConversation(model)
  if (conversation === undefined) return Option.none()
  return Option.fromNullishOr(
    [...conversation.messages].reverse().find((entry) => entry.role === 'assistant' && entry.status === 'streaming'),
  )
}

/** Replaces the assistant entry the stream is writing to, if it is still the one. */
const patchInFlight = (model: ChatModel, patch: (entry: ChatEntry) => ChatEntry): ChatModel =>
  Option.match(inFlight(model), {
    onNone: () => model,
    onSome: (entry) =>
      updateConversation(model, (conversation) =>
        modifyFields(conversation, {
          messages: (messages) => messages.map((message) => (message.id === entry.id ? patch(message) : message)),
        }),
      ),
  })

export const activeConversation = (model: ChatModel): Conversation | undefined =>
  model.conversations.find((conversation) => conversation.id === model.activeConversationId)

/** Rewrites the active conversation, leaving every other one untouched. */
const updateConversation = (model: ChatModel, patch: (conversation: Conversation) => Conversation): ChatModel =>
  modifyFields(model, {
    conversations: (conversations) =>
      conversations.map((conversation) =>
        conversation.id === model.activeConversationId ? patch(conversation) : conversation,
      ),
  })

const blankAssistant = (id: string): ChatEntry => ({
  id,
  role: 'assistant',
  text: '',
  reasoning: '',
  status: 'streaming',
  attachments: [],
})

export const init: ChatModel = {
  screen: 'recents',
  activeConversationId: '',
  conversations: [],
  draft: '',
  attachments: [],
  isPickingAttachment: false,
  reasoningFor: '',
  notice: '',
  nextId: 1,
}

export const update = (model: ChatModel, message: ChatMessage): UpdateReturn =>
  ChatMessageUnion.match<UpdateReturn>(message, {
    ChangedDraft: ({ draft }) => ({ model: modifyFields(model, { draft: () => draft }) }),

    // The composer is disabled while a turn runs, so this arm does not have to
    // decide what happens when one is already in flight - but it still refuses a
    // send with nothing in it, because a keyboard's return key will do it anyway.
    ClickedSend: () => {
      const text = model.draft.trim()
      if (text === '' && model.attachments.length === 0) return { model }
      const conversation = activeConversation(model)
      if (conversation === undefined) return { model }

      const user: ChatEntry = {
        id: `m${model.nextId}`,
        role: 'user',
        text,
        reasoning: '',
        status: 'done',
        attachments: model.attachments,
      }

      return {
        model: modifyFields(model, {
          draft: () => '',
          attachments: () => [],
          nextId: (nextId) => nextId + 1,
          conversations: (conversations) =>
            conversations.map((entry) =>
              entry.id === conversation.id
                ? modifyFields(entry, {
                    // The first message names the chat. Doing it here rather than
                    // in the view means the recents list and the header cannot
                    // disagree about what a conversation is called.
                    title: (title) => (title === 'New chat' ? titleFrom(text) : title),
                    updatedAt: () => Date.now(),
                    messages: (messages) => [...messages, user, blankAssistant(`m${model.nextId + 1}`)],
                  })
                : entry,
            ),
        }),
      }
    },

    // Stops the turn by ending it. The dependency the subscription watches is
    // derived from the in-flight entry, so this one field is what stops the
    // generation - no interrupt Command, and nothing to get wrong about ordering.
    ClickedStop: () => ({
      model: patchInFlight(model, (entry) => modifyFields(entry, { status: () => 'cancelled' })),
    }),

    ReceivedReasoningDelta: ({ delta }) => ({
      model: patchInFlight(model, (entry) => modifyFields(entry, { reasoning: (reasoning) => reasoning + delta })),
    }),

    ReceivedTextDelta: ({ delta }) => ({
      model: patchInFlight(model, (entry) => modifyFields(entry, { text: (text) => text + delta })),
    }),

    CompletedTurn: () => ({ model: patchInFlight(model, (entry) => modifyFields(entry, { status: () => 'done' })) }),

    FailedTurn: ({ reason }) => ({
      model: patchInFlight(model, (entry) =>
        modifyFields(entry, {
          status: () => 'failed',
          // Text that arrived before the failure is kept: a reply cut off mid
          // sentence is still something the user read.
          text: (text) => (text === '' ? `⚠ ${reason}` : text),
        }),
      ),
    }),

    ClickedLink: ({ url }) => ({
      model: modifyFields(model, { notice: () => '' }),
      commands: [OpenLink({ url })],
    }),

    // The Command already opened it. The Model now knows it happened and needs no
    // state change, which is what an arm with nothing to do looks like.
    OpenedLink: () => ({ model }),

    FailedToOpenLink: ({ url }) => ({
      model: modifyFields(model, { notice: () => `That link cannot be opened: ${url}` }),
    }),

    DismissedNotice: () => ({ model: modifyFields(model, { notice: () => '' }) }),

    OpenedReasoning: ({ id }) => {
      const entry = activeConversation(model)?.messages.find((message) => message.id === id)
      // Only an entry that has a trace to show can be opened. Without this a tap on
      // a user message would open an empty sheet, which reads as a bug.
      if (entry === undefined || entry.reasoning === '') return { model }
      return { model: modifyFields(model, { reasoningFor: () => id }) }
    },

    DismissedReasoning: () => ({ model: modifyFields(model, { reasoningFor: () => '' }) }),

    ClickedAddPhoto: () => ({
      model: modifyFields(model, { isPickingAttachment: () => true }),
      commands: [PickImage()],
    }),

    PickedAttachment: ({ uri, width, height }) => ({
      model: modifyFields(model, {
        isPickingAttachment: () => false,
        attachments: (attachments) => [...attachments, { id: `a${model.nextId}`, uri, width, height }],
      }),
    }),

    DismissedAttachmentPicker: () => ({ model: modifyFields(model, { isPickingAttachment: () => false }) }),

    RemovedAttachment: ({ id }) => ({
      model: modifyFields(model, {
        attachments: (attachments) => attachments.filter((attachment) => attachment.id !== id),
      }),
    }),

    OpenedRecents: () => ({ model: modifyFields(model, { screen: () => 'recents' }) }),

    OpenedConversation: ({ conversationId }) => {
      if (!model.conversations.some((conversation) => conversation.id === conversationId)) return { model }
      return { model: modifyFields(model, { screen: () => 'chat', activeConversationId: () => conversationId }) }
    },

    StartedNewChat: () => {
      const id = `c${model.nextId}`
      return {
        model: modifyFields(model, {
          screen: () => 'chat',
          activeConversationId: () => id,
          draft: () => '',
          attachments: () => [],
          nextId: (nextId) => nextId + 1,
          conversations: (conversations) => [...conversations, { id, title: 'New chat', messages: [], updatedAt: Date.now() }],
        }),
      }
    },
  })

/** The first line of what was said, which is what a chat is named after. */
const titleFrom = (text: string): string => {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return 'New chat'
  return trimmed.length <= 42 ? trimmed : `${trimmed.slice(0, 42)}…`
}

// --- THE REQUEST ------------------------------------------------------------

/** What the model is asked, and what it is asked with. */
export type ChatRequest = {
  readonly system: string
  readonly messages: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>
}

const SYSTEM_PROMPT = [
  'You are a helpful assistant running entirely on the user’s iPhone, with no network access.',
  'Answer concisely. Prefer short paragraphs, and use Markdown for structure.',
  'Be honest about what you do not know.',
].join('\n')

/**
 * Roughly how much of the window a conversation may fill.
 *
 * Apple Foundation Models has a fixed 4096-token window that the system prompt,
 * the transcript and the reply all draw from, and the provider neither trims the
 * transcript nor estimates tokens - so an app that does nothing about it fails on a
 * long chat with an error nobody can act on.
 *
 * The arithmetic, in characters at roughly four to a token:
 *
 * ```
 *   4096 tokens x 4            = 16384
 *   - 1024 reserved for output =  -4096   (maxTokens in apple.ts)
 *   - ~60 tokens of system     =  -240
 *                              = 12048
 * ```
 *
 * Counting tokens properly needs the native API and iOS 26.4, so this is
 * deliberately a character budget. Coarse on purpose: being wrong costs a little
 * context, whereas an unbounded transcript costs the whole reply.
 */
const CONTEXT_CHARACTERS = 12_000

/** The request the world should currently be answering, or empty if nothing is in flight. */
export const activeRequest = (model: ChatModel): string => {
  const conversation = activeConversation(model)
  if (conversation === undefined) return ''

  const streaming = [...conversation.messages]
    .reverse()
    .find((entry) => entry.role === 'assistant' && entry.status === 'streaming')
  // Nothing is being asked, so nothing should be running. This is also what stops
  // the stream when a turn is cancelled or fails.
  if (streaming === undefined) return ''

  // Everything before the in-flight entry is history. The entry itself is left
  // out entirely - that is the whole trick, and the reason a token does not change
  // the request and restart the stream it is arriving on.
  const history = conversation.messages.slice(0, conversation.messages.indexOf(streaming))

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let budget = CONTEXT_CHARACTERS
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    if (entry === undefined) continue
    if (entry.text === '' && entry.attachments.length === 0) continue

    const content = [entry.text, ...entry.attachments.map((attachment) => `[photo: ${attachment.uri}]`)]
      .join('\n')
      .trim()
    if (content === '') continue
    // Checked before clipping as well as after: a budget that reached exactly zero
    // on the previous turn would otherwise slice the next one to nothing and add an
    // empty message, which is a turn that does not exist.
    if (budget <= 0) break

    // Clipped to fit rather than dropped whole: a half sentence still carries the
    // subject, and a chat whose oldest turn vanished mid-word reads as a bug.
    const clipped = content.length <= budget ? content : `${content.slice(0, budget)}…`
    budget -= clipped.length
    messages.unshift({ role: entry.role, content: clipped })
  }

  return JSON.stringify({ system: SYSTEM_PROMPT, messages } satisfies ChatRequest)
}

/** Exported for the view and the tests: is a turn in flight right now? */
export const isStreaming = (model: ChatModel): boolean => Option.isSome(inFlight(model))
