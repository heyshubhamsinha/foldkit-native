/**
 * The brain: Apple Foundation Models, on the device.
 *
 * Everything here is the model and its wire format, and nothing here knows the
 * Model exists. It takes a request and produces a Stream of {@link BrainEvent};
 * `chat/model.ts` decides what an event means. That split is the reason a Story can
 * drive a whole conversation - tokens, a stop, a failure - without this file being
 * imported once.
 *
 * ## No keys, no network, no cost
 *
 * The model runs on the phone. Nothing here opens a socket, reads a config file or
 * asks for a credential, which is why the app is one `npm run ios` away from
 * working rather than one API key away.
 *
 * ## The trade this makes
 *
 * Apple Foundation Models **executes tool calls itself** and does not run the AI
 * SDK's step callbacks. So the retrieval loop that the OpenAI version of this app
 * expressed in the Model - a tool call arriving as a Message, `update` answering it
 * with a Command, the answer changing the request, the runtime re-running it - is
 * not available here. That loop was the point of the exercise, so dropping it is a
 * real loss and is recorded in `docs/LEARNINGS.md` rather than papered over.
 *
 * What survives is the part that was always the harder half: a subscription whose
 * lifetime comes from the Model, a stream that can be stopped mid-sentence, and a
 * conversation that is one immutable value throughout.
 */

import { Effect, Stream } from 'effect'
import type { ChatRequest } from './model'

/**
 * One thing the model said.
 *
 * A tagged union rather than a bare string because the caller turns each into a
 * different Message, and `update` matching on a literal is the whole point of the
 * design. `completed` and `failed` are facts too - a stream that ended quietly would
 * leave the message "streaming" forever.
 */
export type BrainEvent =
  | { readonly _tag: 'reasoning'; readonly delta: string }
  | { readonly _tag: 'text'; readonly delta: string }
  | { readonly _tag: 'completed' }
  | { readonly _tag: 'failed'; readonly reason: string }

/**
 * What a device that cannot run the model is told.
 *
 * Checked up front rather than caught from a thrown error, because "Android" and
 * "an iPhone from 2021" are two different facts and the user needs to know which.
 */
export const UNAVAILABLE =
  'Apple Intelligence is not available on this device. Foundation Models needs iOS 26 or later on Apple Intelligence hardware; on Android it needs a different provider.'

/**
 * Turns a provider error into something a person can act on.
 *
 * `AppleLLMError.code` is the documented, stable surface; `message` is not, and
 * showing a user a string that may change between OS releases is worse than showing
 * them the one thing that will not.
 */
const describeError = (error: unknown): string => {
  const code = (error as { readonly code?: unknown } | undefined)?.code

  if (code === 'MODEL_UNAVAILABLE' || code === 'UNSUPPORTED_OS') return UNAVAILABLE
  if (code === 'CONTEXT_WINDOW_EXCEEDED') {
    return 'This conversation outgrew the 4096-token window Apple Foundation Models has. Start a new chat to carry on.'
  }
  if (code === 'GENERATION_ERROR') return 'The model could not finish that reply. Try again.'

  return error instanceof Error && error.message !== ''
    ? error.message
    : 'The model could not complete this reply.'
}

/**
 * The conversation, read by the model.
 *
 * An async generator because that is what `fullStream` is, and because an async
 * generator is interruptible in a way a `for await` inside a bare Effect is not:
 * `Effect.callback` supplies an `AbortSignal`, which becomes the AI SDK's
 * `abortSignal`, and when the runtime stops the subscription the request is
 * cancelled at the source. Without that, a cancelled turn would keep generating into
 * a message nobody is drawing.
 */
const fromApple = async function* (request: ChatRequest, signal: AbortSignal): AsyncGenerator<BrainEvent> {
  // Imported here rather than at the top of the file: both pull in React Native
  // native modules, and this module is imported by tests that run in Node.
  const [{ streamText }, { apple }] = await Promise.all([import('ai'), import('@react-native-ai/apple')])

  if (!apple.isAvailable()) {
    yield { _tag: 'failed', reason: UNAVAILABLE }
    return
  }

  let failure: string | undefined

  const result = streamText({
    model: apple(),
    system: request.system,
    messages: [...request.messages],
    abortSignal: signal,
    // The window is 4096 tokens for *everything* - system, transcript and reply -
    // and the provider reserves nothing. Capping the reply is what turns that
    // shared budget into one this app controls, and it is why the history budget
    // in `activeRequest` is the number it is.
    maxOutputTokens: 1024,
    // `fullStream` carries an `error` part, but reading it here as well means a
    // failure is reported once, by the same code, however the SDK chose to
    // surface it.
    onError: ({ error }) => {
      failure = describeError(error)
    },
  })

  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      yield { _tag: 'text', delta: part.text }
    } else if (part.type === 'reasoning-delta') {
      yield { _tag: 'reasoning', delta: part.text }
    } else if (part.type === 'error') {
      failure = describeError(part.error)
    }
  }

  if (failure !== undefined) {
    yield { _tag: 'failed', reason: failure }
    return
  }
  yield { _tag: 'completed' }
}

/** Streams a reply. */
export const streamReply = (request: ChatRequest): Stream.Stream<BrainEvent> =>
  Effect.callback<AsyncIterable<BrainEvent>>((resume, signal) => {
    resume(Effect.succeed(fromApple(request, signal)))
  }).pipe(
    Effect.map((events) =>
      // A failure to *read* the stream is a defect, not a fact about the reply -
      // every way the model can go wrong is already a `failed` event, which the
      // Model records and the view shows. Leaving one path on the error channel
      // would mean the subscription had to handle errors it can never receive.
      Stream.orDie(Stream.fromAsyncIterable(events, (error) => new Error(String(error)))),
    ),
    Stream.unwrap,
  )
