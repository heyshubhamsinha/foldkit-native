/**
 * The application.
 *
 * One Model, one pure `update`, one view, and one subscription - which is the piece
 * the Todo list did not need. The subscription is declared here rather than in
 * `chat/stream.ts` only because this is where the framework's `subscriptions` field
 * lives; the interesting half is that there is no half.
 *
 * Compare the size of this with what it declares. The chat streams a reply token by
 * token, can be stopped halfway, and carries a whole conversation as one immutable
 * value - and the declaration of all of that is this file. Nothing here starts a
 * stream, and nothing here has to know how one ends.
 */

import { Runtime } from '@foldkit-native/core'
import * as Chat from './chat/model'
import { chatView } from './chat/view'
import { replyStream } from './chat/stream'

export const app = Runtime.makeApplication<Chat.ChatModel, Chat.ChatMessage>({
  Model: Chat.ChatModel,
  init: () => ({ model: Chat.init }),
  update: Chat.update,
  view: chatView,
  subscriptions: { reply: replyStream },
})
