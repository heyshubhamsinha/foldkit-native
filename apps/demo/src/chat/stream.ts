/**
 * The bridge between the Model and the model.
 *
 * One dependency, one function. The subscription watches the request the Model says
 * it wants answered; the runtime runs it; every event it produces becomes a Message
 * and goes through the same queue a tap uses.
 *
 * This is the whole of the machinery. There is no loop here, and that is the
 * trade this provider forces: Apple Foundation Models executes tool calls itself,
 * so the retrieval loop that a networked provider let the Model drive - a tool call
 * arriving as a Message, `update` answering it with a Command, the answer changing
 * the request, the runtime re-running it - is not available. What is left is the
 * part that was always the harder half: a subscription whose lifetime comes from the
 * Model, and a stream that can be stopped mid-sentence.
 *
 * ## Why one string dependency
 *
 * The dependency is the serialized request and nothing else. That sounds blunt, and
 * it is deliberately so:
 *
 * - A token arriving does **not** change it, because `activeRequest` omits the
 *   in-flight reply. Were partial text included, every token would restart the
 *   stream and nothing would ever finish.
 * - Ending a turn changes it back to empty, which is what stops the generation.
 * - Sending the next message changes it, which starts the next turn.
 *
 * So one field encodes all three transitions, and there is no second condition to
 * keep in agreement with the first.
 */

import { Schema, Stream } from 'effect'
import { Subscription } from '@foldkit-native/core'
import { streamReply, type BrainEvent } from './apple'
import { activeRequest, type ChatMessage, type ChatModel, type ChatRequest } from './model'

/**
 * One brain event, one fact.
 *
 * The mapping is exhaustive because `BrainEvent` is a union: adding a kind of event
 * on the wire is a compile error here rather than a silently dropped token.
 */
const toMessage = (event: BrainEvent): ChatMessage => {
  switch (event._tag) {
    case 'reasoning':
      return { _tag: 'ReceivedReasoningDelta', delta: event.delta }
    case 'text':
      return { _tag: 'ReceivedTextDelta', delta: event.delta }
    case 'completed':
      return { _tag: 'CompletedTurn' }
    case 'failed':
      return { _tag: 'FailedTurn', reason: event.reason }
  }
}

export const replyStream = Subscription.make<ChatModel, ChatMessage, { readonly request: string }>({
  dependenciesSchema: Schema.Struct({ request: Schema.String }),
  modelToDependencies: (model) => ({ request: activeRequest(model) }),
  // Empty means nothing is in flight. `Stream.empty` rather than a stream that
  // closes immediately, so the runtime has a fiber that simply never emits - the
  // same thing it does for a subscription that is watching nothing.
  dependenciesToStream: ({ request }) =>
    request === '' ? Stream.empty : Stream.map(streamReply(JSON.parse(request) as ChatRequest), toMessage),
})
