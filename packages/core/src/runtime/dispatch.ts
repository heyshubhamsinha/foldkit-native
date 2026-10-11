import type { RuntimeHandle } from './runtime.js'

/**
 * `Dispatch`: the one way a Message gets into a running application from
 * outside it.
 *
 * A tap and a network response arrive through the runtime's own loop, because
 * the view and the Commands are inside it. Anything else - a push notification,
 * a deep link, a DevTools panel, an MCP client reading and writing a running app
 * - is outside, and needs the same door.
 *
 * It is the same door, not a second one. A dispatched Message goes through the
 * same queue, the same pure `update`, and the same render as a tap, so a
 * feature cannot work from a push notification and silently fail when the same
 * thing is triggered by a button. That is the property worth having: one path
 * in means one set of transitions out.
 *
 * ```ts
 * const handle = run(app, host)
 *
 * Dispatch.send(handle, Message.ClickedIncrement())
 * ```
 *
 * Dispatching is not a debugging shortcut. It is the supported way to drive an
 * application from outside itself, and every caller is treated identically.
 */

export interface DispatchTarget<Message> {
  readonly dispatch: (message: Message) => void
}

/**
 * Puts a Message through `update`.
 *
 * Rejects anything that is not a Message, rather than letting a malformed value
 * reach an exhaustive `match` and fail somewhere further from the mistake.
 */
export const send = <Message extends { readonly _tag: string }>(
  target: DispatchTarget<Message> | RuntimeHandle<any, Message>,
  message: Message,
): void => {
  if (typeof message !== 'object' || message === null || typeof message._tag !== 'string') {
    throw new TypeError(`Dispatch.send expects a Message with a string _tag, but received ${JSON.stringify(message)}`)
  }
  target.dispatch(message)
}

/**
 * Sends several Messages in order.
 *
 * Each one is a separate transition with its own render, so this is the honest
 * way to replay a sequence - not a way to batch one that the application would
 * never produce.
 */
export const sendAll = <Message extends { readonly _tag: string }>(
  target: DispatchTarget<Message> | RuntimeHandle<any, Message>,
  messages: ReadonlyArray<Message>,
): void => {
  for (const message of messages) send(target, message)
}