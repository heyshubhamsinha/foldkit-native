/**
 * The chat, drawn.
 *
 * Two screens and a sheet, all decided by one field on the Model. There is no
 * router here and no navigation library: `screen` is state like any other, and a
 * Scene test can walk between the two screens without a device or a navigator's
 * test harness.
 *
 * Everything on screen is a real native element. `scroll-view` scrolls,
 * `text-input` is a `UITextField`, `modal` is the real sheet presentation, and a
 * pressable is the responder system rather than a synthetic event. Nothing is a
 * styled rectangle pretending to be something else.
 *
 * ## What is deliberately missing
 *
 * The original app leans on four libraries that render through a React tree, and
 * this one has no React tree at all:
 *
 * - **Liquid Glass and Skia** draw surfaces no native element here exposes. The
 *   reasoning sheet is a `modal`, which is the platform's own answer, and the
 *   thinking indicator is an `activity-indicator`.
 * - **An icon font** would need `require('./font.ttf')` per glyph; the buttons use
 *   text characters instead, as the Todo demo does.
 * - **A scroll-to-bottom button** needs a handle to scroll with, and this
 *   architecture has no refs. Inventing the first one for a convenience control
 *   would cost more than it buys; the list is short enough to read.
 *
 * None of these is a gap in the Model - they are all view-only - so any of them
 * could be added without touching `update`.
 */

import type { NativeViewBuilder, VNode } from '@foldkit-native/core'
import { markdown } from './markdown'
import { ChatMessageUnion, type ChatEntry, type ChatModel, type Conversation } from './model'

/** The builder every screen below takes. Named because the signatures get long. */
type H = NativeViewBuilder<typeof ChatMessageUnion.Type>

const styles = {
  screen: { flex: 1, backgroundColor: '#0d1117' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1c232b',
    backgroundColor: '#0d1117',
  },
  title: { flex: 1, color: '#ffffff', fontSize: 17, fontWeight: '700' },
  quiet: { color: '#8b95a1', fontSize: 14 },
  body: { flex: 1, paddingHorizontal: 14, paddingTop: 12 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    backgroundColor: '#2f6bff',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
  },
  botBubble: {
    alignSelf: 'flex-start',
    maxWidth: '92%',
    backgroundColor: '#161c23',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
  },
  userText: { color: '#ffffff', fontSize: 16, lineHeight: 22 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thinking: { color: '#6b7683', fontSize: 14 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#1c232b',
  },
  input: {
    flex: 1,
    minHeight: 40,
    backgroundColor: '#161c23',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    color: '#ffffff',
    fontSize: 16,
  },
  send: { backgroundColor: '#2f6bff', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 11 },
  stop: { backgroundColor: '#e05d4d', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 11 },
  sendLabel: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
  ghost: { paddingHorizontal: 10, paddingVertical: 8 },
  ghostLabel: { color: '#5aa2ff', fontSize: 15, fontWeight: '600' },
  attach: { paddingHorizontal: 12, paddingVertical: 10 },
  attachLabel: { color: '#8b95a1', fontSize: 22 },
  thumbnail: { width: 52, height: 52, borderRadius: 10, marginRight: 8 },
  notice: { backgroundColor: '#2a1f1c', paddingHorizontal: 14, paddingVertical: 10 },
  noticeLabel: { color: '#ffb4a2', fontSize: 13 },
  empty: { alignItems: 'center', paddingVertical: 48, gap: 8 },
  emptyTitle: { color: '#ffffff', fontSize: 20, fontWeight: '700' },
  card: { backgroundColor: '#161c23', borderRadius: 14, padding: 14, marginBottom: 10 },
  cardTitle: { color: '#ffffff', fontSize: 15, fontWeight: '600', marginBottom: 3 },
  cardPreview: { color: '#8b95a1', fontSize: 13 },
  sheet: { flex: 1, backgroundColor: '#0d1117' },
  sheetText: { color: '#c3ccd6', fontSize: 15, lineHeight: 22 },
  thoughtLink: { alignSelf: 'flex-start', marginBottom: 6 },
} as const

export const chatView = (model: ChatModel, h: H): VNode =>
  model.screen === 'recents' ? recents(model, h) : conversation(model, h)

// --- RECENTS ----------------------------------------------------------------

const recents = (model: ChatModel, h: H): VNode =>
  h(
    'safe-area-view',
    { style: styles.screen, testID: 'recents' },
    h(
      'view',
      { style: styles.bar },
      h('text', { style: styles.title, testID: 'recents-title' }, 'Chats'),
      h(
        'pressable',
        {
          style: styles.send,
          testID: 'new-chat',
          accessibilityRole: 'button',
          accessibilityLabel: 'New chat',
          onPress: () => ChatMessageUnion.StartedNewChat(),
        },
        h('text', { style: styles.sendLabel }, 'New'),
      ),
    ),
    model.conversations.length === 0
      ? h(
          'view',
          { style: styles.empty, testID: 'recents-empty' },
          h('text', { style: styles.emptyTitle }, 'No chats yet'),
          h('text', { style: styles.quiet }, 'It runs entirely on this device.'),
        )
      : h(
          'scroll-view',
          { style: styles.body, testID: 'recents-list' },
          // Newest first, and keyed by id so a new chat appears at the top without
          // rebuilding the rows under it.
          ...[...model.conversations].reverse().map((entry) =>
            h(
              'pressable',
              {
                key: entry.id,
                style: styles.card,
                testID: `conversation-${entry.id}`,
                accessibilityRole: 'button',
                accessibilityLabel: `Open ${entry.title}`,
                onPress: () => ChatMessageUnion.OpenedConversation({ conversationId: entry.id }),
              },
              h('text', { style: styles.cardTitle }, entry.title),
              h('text', { style: styles.cardPreview }, preview(entry)),
            ),
          ),
        ),
  )

const preview = (conversation: Conversation): string => {
  const last = conversation.messages[conversation.messages.length - 1]
  if (last === undefined) return 'No messages yet'
  // A trailing empty assistant entry is the reply in progress, and "…" alone would
  // read as a broken row rather than as one that is still being written.
  const text = last.text === '' ? (last.status === 'streaming' ? 'Thinking…' : '…') : last.text
  return text.length <= 80 ? text : `${text.slice(0, 80)}…`
}

// --- CONVERSATION -----------------------------------------------------------

const conversation = (model: ChatModel, h: H): VNode => {
  const current = model.conversations.find((entry) => entry.id === model.activeConversationId)
  const streaming =
    current?.messages.some((message) => message.role === 'assistant' && message.status === 'streaming') ?? false

  return h(
    'safe-area-view',
    { style: styles.screen, testID: 'chat' },
    h(
      'view',
      { style: styles.bar },
      h(
        'pressable',
        {
          style: styles.ghost,
          testID: 'back',
          accessibilityRole: 'button',
          accessibilityLabel: 'Back to chats',
          onPress: () => ChatMessageUnion.OpenedRecents(),
        },
        h('text', { style: styles.ghostLabel }, '‹ Chats'),
      ),
      h('text', { style: styles.title, testID: 'chat-title' }, current?.title ?? 'New chat'),
    ),
    model.notice === ''
      ? null
      : h(
          'view',
          { style: styles.notice, testID: 'notice' },
          h('text', { style: styles.noticeLabel }, model.notice),
        ),
    // `behavior: padding` rather than `adjustResize`, because resize shrinks the
    // list on Android and not on iOS, and a view that behaves differently on two
    // platforms is a bug waiting for a bug report.
    h(
      'keyboard-avoiding-view',
      { style: { flex: 1 }, behavior: 'padding' },
      h(
        'scroll-view',
        { style: styles.body, testID: 'messages' },
        current === undefined || current.messages.length === 0
          ? h(
              'view',
              { style: styles.empty, testID: 'chat-empty' },
              h('text', { style: styles.emptyTitle }, 'Ask anything'),
              h('text', { style: styles.quiet }, 'Nothing leaves your phone.'),
            )
          : h('view', null, ...current.messages.map((message) => entry(message, h))),
      ),
      ...model.attachments.map((attachment) => attachmentChip(attachment, h)),
      h(
        'view',
        { style: styles.composer },
        h(
          'pressable',
          {
            style: styles.attach,
            testID: 'add-photo',
            accessibilityRole: 'button',
            accessibilityLabel: 'Add photo',
            onPress: () => ChatMessageUnion.ClickedAddPhoto(),
          },
          h('text', { style: styles.attachLabel }, '＋'),
        ),
        h('text-input', {
          style: styles.input,
          testID: 'input',
          accessibilityLabel: 'Message',
          value: model.draft,
          placeholder: 'Message',
          placeholderTextColor: '#6b7683',
          editable: !streaming,
          multiline: true,
          onChange: (draft) => ChatMessageUnion.ChangedDraft({ draft }),
          onSubmitEditing: () => ChatMessageUnion.ClickedSend(),
        }),
        streaming
          ? h(
              'pressable',
              {
                style: styles.stop,
                testID: 'stop',
                accessibilityRole: 'button',
                accessibilityLabel: 'Stop generating',
                onPress: () => ChatMessageUnion.ClickedStop(),
              },
              h('text', { style: styles.sendLabel }, 'Stop'),
            )
          : h(
              'pressable',
              {
                style: styles.send,
                testID: 'send',
                accessibilityRole: 'button',
                accessibilityLabel: 'Send',
                onPress: () => ChatMessageUnion.ClickedSend(),
              },
              h('text', { style: styles.sendLabel }, 'Send'),
            ),
      ),
    ),
    reasoningSheet(model, h),
  )
}

const attachmentChip = (attachment: ChatModel['attachments'][number], h: H): VNode =>
  h(
    'view',
    { style: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 8 } },
    h('image', {
      style: styles.thumbnail,
      testID: `attachment-${attachment.id}`,
      accessibilityLabel: 'Attached photo',
      source: { uri: attachment.uri },
    }),
    h(
      'pressable',
      {
        style: styles.ghost,
        testID: `remove-${attachment.id}`,
        accessibilityRole: 'button',
        accessibilityLabel: 'Remove photo',
        onPress: () => ChatMessageUnion.RemovedAttachment({ id: attachment.id }),
      },
      h('text', { style: styles.ghostLabel }, '✕'),
    ),
  )

// --- ONE ENTRY --------------------------------------------------------------

const entry = (message: ChatEntry, h: H): VNode =>
  message.role === 'user'
    ? h(
        'view',
        { key: message.id, style: styles.userBubble, testID: `entry-${message.id}` },
        h('text', { style: styles.userText }, message.text),
        ...message.attachments.map((attachment) =>
          h('image', {
            key: attachment.id,
            style: { width: 160, height: 160, borderRadius: 10, marginTop: 8 },
            accessibilityLabel: 'Attached photo',
            source: { uri: attachment.uri },
          }),
        ),
      )
    : h(
        'view',
        { key: message.id, style: styles.botBubble, testID: `entry-${message.id}` },
        message.reasoning === ''
          ? null
          : h(
              'pressable',
              {
                style: styles.thoughtLink,
                testID: `reasoning-${message.id}`,
                accessibilityRole: 'button',
                accessibilityLabel: 'Show thought process',
                onPress: () => ChatMessageUnion.OpenedReasoning({ id: message.id }),
              },
              h('text', { style: styles.ghostLabel }, 'Show thought process'),
            ),
        // An empty assistant entry is not a blank message - it is a reply that has
        // not started. Saying so is the difference between "broken" and "working".
        ...(message.text === ''
          ? [
              h(
                'view',
                { style: styles.row, testID: 'thinking' },
                h('activity-indicator', { size: 'small' }),
                h('text', { style: styles.thinking }, message.status === 'cancelled' ? 'Stopped' : 'Thinking…'),
              ),
            ]
          : markdown(message.text, h)),
      )

// --- THE THOUGHT TRACE ------------------------------------------------------

/**
 * The sheet.
 *
 * A real `modal`, so the platform presents and dismisses it and the back gesture
 * works. What shows inside is decided by `reasoningFor` in the Model, which makes
 * "which trace is open" state like any other - and something a test can assert
 * without presenting anything.
 */
const reasoningSheet = (model: ChatModel, h: H): VNode | null => {
  if (model.reasoningFor === '') return null
  const current = model.conversations.find((entry) => entry.id === model.activeConversationId)
  const target = current?.messages.find((message) => message.id === model.reasoningFor)
  if (target === undefined) return null

  return h(
    'modal',
    { visible: true, transparent: true, testID: 'reasoning-sheet' },
    h(
      'pressable',
      {
        style: { flex: 1, backgroundColor: '#000000aa', justifyContent: 'flex-end' },
        accessibilityLabel: 'Close thought process',
        onPress: () => ChatMessageUnion.DismissedReasoning(),
      },
      h(
        'view',
        { style: styles.sheet },
        h(
          'view',
          { style: styles.bar },
          h('text', { style: styles.title }, 'Thought process'),
          h(
            'pressable',
            {
              style: styles.ghost,
              testID: 'close-reasoning',
              accessibilityRole: 'button',
              accessibilityLabel: 'Close thought process',
              onPress: () => ChatMessageUnion.DismissedReasoning(),
            },
            h('text', { style: styles.ghostLabel }, 'Done'),
          ),
        ),
        h('scroll-view', { style: { padding: 16 } }, h('text', { style: styles.sheetText }, target.reasoning)),
      ),
    ),
  )
}
