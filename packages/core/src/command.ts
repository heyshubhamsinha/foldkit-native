import { Effect, Schema } from 'effect'
import { defineTaggedUnion } from './schema.js'

/**
 * Commands: side effects as values that `update` returns.
 *
 * The rule this module exists to enforce is that `update` is pure. A handler
 * cannot `await` a request, cannot start a timer and cannot write to storage,
 * because `update` is a function from `(Model, Message)` to a new Model and
 * nothing else - it may be called twice with the same input, replayed in a test
 * and inspected by a person reading a diff.
 *
 * So the side effect is described instead of performed. `update` returns a
 * Command; the runtime runs it, and whatever the Effect produces comes back as
 * a Message that goes through `update` again. The loop closes on facts, and
 * every fact is visible in one exhaustive `match`.
 *
 * ```ts
 * const DelayReset = Command.define('DelayReset', {
 *   args: { seconds: Schema.Number },
 *   messages: [Message.CompletedDelayReset],
 *   execute: ({ seconds }) => Effect.as(Effect.sleep(\`\${seconds} seconds\`), Message.CompletedDelayReset()),
 * })
 * ```
 */

/**
 * What interrupting a Command produced.
 *
 * `Interrupted` means at least one invocation was actually stopped, so its
 * Messages are guaranteed never to dispatch. `NotFound` means nothing held the
 * key: the work had already finished, or was never started. A caller that
 * treats the two the same will dispatch a follow-up for work that is still
 * running, so the two are named separately on purpose.
 */
export const InterruptOutcome = defineTaggedUnion({
  /** At least one holder of the key was stopped. Its Messages will never dispatch. */
  Interrupted: {},
  /** Nothing held the key. The work had already finished, or never started. */
  NotFound: {},
})
export type InterruptOutcome = typeof InterruptOutcome.Type

/**
 * A named Effect that produces a Message.
 *
 * `args` records what the Command was built with, which is what a trace or a
 * test reports, so a `FetchWeather` in a log says which zip code it fetched
 * without the Effect having to be re-run to find out. `key` is present on an
 * interruptible Command: it addresses this invocation in the runtime's
 * interrupt registry.
 */
export type Command<T, E = never, R = never> = [T] extends [never]
  ? Readonly<{ name: string; args?: Record<string, unknown>; key?: string; effect: Effect.Effect<never, E, R> }>
  : Readonly<{ name: string; args?: Record<string, unknown>; key?: string; effect: Effect.Effect<T, E, R> }>

/**
 * The message-lifting functions a Command has been wrapped in, recorded so a
 * test can replay them. Runtime metadata the runtime itself never reads:
 * production dispatch is unaffected because each lift is already fused into the
 * Effect, and this chain is what lets `Story.resolve` hand back the message the
 * app would really have seen.
 */
const MESSAGE_CHAIN = Symbol.for('foldkit-native.messageChain')

type WithChain = {
  [MESSAGE_CHAIN]?: ReadonlyArray<(message: any) => any>
}

const chainOf = (command: Command<any, any, any>): ReadonlyArray<(message: any) => any> =>
  (command as WithChain)[MESSAGE_CHAIN] ?? []

const withChain = <T, E, R>(
  command: Command<T, E, R>,
  chain: ReadonlyArray<(message: any) => any>,
): Command<T, E, R> => Object.assign(command, { [MESSAGE_CHAIN]: chain }) as Command<T, E, R>

/** A Command definition with no declared args. Call as `Definition()`. */
export interface CommandDefinitionNoArgs<Name extends string, Eff extends Effect.Effect<any, any, any>> {
  readonly name: Name
  (): Readonly<{ name: Name; effect: Eff; key?: string }>
}

/** A Command definition with declared args. Call as `Definition(args)`. */
export interface CommandDefinitionWithArgs<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  Eff extends Effect.Effect<any, any, any>,
> {
  readonly name: Name
  (args: Schema.Schema.Type<Schema.Struct<Fields>>): Readonly<{
    name: Name
    args: Schema.Schema.Type<Schema.Struct<Fields>>
    effect: Eff
    key?: string
  }>
}

/** Either shape, for anything that only needs a Command's name. */
export type CommandDefinition<Name extends string = string, ResultMessage = any> =
  | CommandDefinitionNoArgs<Name, Effect.Effect<ResultMessage, any, any>>
  | CommandDefinitionWithArgs<Name, any, Effect.Effect<ResultMessage, any, any>>

/** What calling an interruptible Definition produces. */
type DefinitionReturn<Name extends string, Args, Eff> = Readonly<{
  name: Name
  args: Args
  key?: string
  effect: Eff
}>

/**
 * A definition with no args is callable with no argument, the way a Message
 * variant with no fields is. `Refresh()` rather than `Refresh({})`: the second
 * one reads as though it had fields, and there is nothing to put in them.
 */
type DefinitionCall<Name extends string, Args extends Record<string, unknown>, Eff> = [keyof Args] extends [never]
  ? (args?: void) => DefinitionReturn<Name, Args, Eff>
  : (args: Args) => DefinitionReturn<Name, Args, Eff>

/**
 * An interruptible Command definition, which also builds the Command that stops
 * it.
 *
 * The call signature is a conditional rather than a plain parameter because the
 * no-args case has to be callable with nothing: writing it as
 * `(args: MakeArgs<Args>)` would make the parameter a *function* type, and
 * `Refresh({ id })` would then be checked against a signature it cannot satisfy.
 */
export type InterruptibleDefinition<
  Name extends string,
  Args extends Record<string, unknown>,
  KeyArgs extends Record<string, unknown>,
  Eff extends Effect.Effect<any, any, any>,
> = {
  readonly name: Name
  /**
   * A Command that stops every invocation currently held under the key, and
   * produces `toMessage(outcome)` describing whether anything was stopped.
   *
   * Dispatching never interrupts anything: a Command is stopped only when
   * `update` returns this. That is what keeps `update` the single place a
   * decision to cancel is visible.
   */
  readonly Interrupt: {
    /** Stops every invocation held under the Command's own key. */
    (toMessage: (outcome: InterruptOutcome) => any): Readonly<{
      name: string
      args?: Record<string, unknown>
      effect: Effect.Effect<any, never, never>
    }>
    /** Stops only the invocations held under the key these args derive. */
    (keyArgs: KeyArgs, toMessage: (outcome: InterruptOutcome) => any): Readonly<{
      name: string
      args?: Record<string, unknown>
      effect: Effect.Effect<any, never, never>
    }>
  }
} & DefinitionCall<Name, Args, Eff>

/**
 * How an interruptible Command is addressed.
 *
 * `true` keys every invocation by the Command's name, which is what you want
 * when at most one is meaningfully in flight - a search box, a toggle.
 *
 * `{ keyFields, toKey }` derives the key from declared args, so invocations that
 * run concurrently are interrupted independently - one row's upload without
 * disturbing another's.
 *
 * Derive the key from identity the Model already holds (a list item id, an
 * entity id), never from a generated value. `update` is pure: any invocation
 * you could meaningfully target is already distinguished by data in the Model,
 * and a key that exists only in the Command is one nothing else can reproduce.
 */
export type InterruptOption<Args, KeyField extends keyof Args & string = keyof Args & string> =
  | true
  | Readonly<{ keyFields: ReadonlyArray<KeyField>; toKey: (keyArgs: Pick<Args, KeyField>) => string }>

/** The key a definition resolves for one invocation. */
const keyFor = (
  name: string,
  args: Record<string, unknown> | undefined,
  interrupt: InterruptOption<Record<string, unknown>> | undefined,
): string | undefined => {
  if (interrupt === undefined) return undefined
  if (interrupt === true) return name
  const picked: Record<string, unknown> = {}
  for (const field of interrupt.keyFields) picked[field] = args?.[field]
  return interrupt.toKey(picked)
}

/** Builds the `Interrupt` constructor an interruptible definition carries. */
const interruptConstructor = <Name extends string, Args extends Record<string, unknown>, KeyArgs extends Record<string, unknown>>(
  name: Name,
  interrupt: InterruptOption<Args>,
): InterruptibleDefinition<Name, Args, KeyArgs, Effect.Effect<any, any, any>>['Interrupt'] => {
  const build = (keyArgs: Record<string, unknown> | undefined, toMessage: (outcome: InterruptOutcome) => any) => {
    const args: Record<string, unknown> | undefined = keyArgs === undefined ? undefined : { keyArgs }
    // The Effect is never run in `update`; the runtime reads `args` to find the
    // key and produces the Message itself. Building it here keeps the Command a
    // value the runtime can inspect rather than a closure it has to call.
    const effect = Effect.succeed(undefined) as Effect.Effect<any, never, never>
    const command = {
      name: `Interrupt${name}`,
      ...(args === undefined ? {} : { args }),
      effect,
    } as any
    Object.assign(command, {
      [INTERRUPT_REQUEST]: { target: name, keyArgs, toMessage },
    })
    return command
  }

  return ((keyArgsOrToMessage: unknown, maybeToMessage?: unknown) =>
    typeof keyArgsOrToMessage === 'function'
      ? build(undefined, keyArgsOrToMessage as (outcome: InterruptOutcome) => any)
      : build((keyArgsOrToMessage ?? {}) as Record<string, unknown>, maybeToMessage as (outcome: InterruptOutcome) => any)) as any
}

/** What an Interrupt Command asks the runtime to do. Read by the runtime, never by an app. */
const INTERRUPT_REQUEST = Symbol.for('foldkit-native.interruptRequest')

export type InterruptRequest = {
  readonly target: string
  readonly keyArgs: Record<string, unknown> | undefined
  readonly toMessage: (outcome: InterruptOutcome) => any
}

/** The interrupt request a Command carries, if it is an Interrupt Command. */
export const interruptRequestOf = (command: Command<any, any, any>): InterruptRequest | undefined =>
  (command as unknown as { [INTERRUPT_REQUEST]?: InterruptRequest })[INTERRUPT_REQUEST]

/**
 * Defines a Command.
 *
 * Every input is a named field:
 *
 * - `args` declares the args Schema. Omit it and the Definition is called with
 *   no argument; declare it and `execute` receives the args.
 * - `messages` lists every Message this Command can produce. Naming them is
 *   what lets a test resolve the Command by identity, and it is checked against
 *   the Message type rather than trusted.
 * - `execute` is the Effect. It is not called when the Command is constructed.
 * - `interrupt` opts into interruption.
 *
 * Constructing a Command never runs `execute`. With `args` declared the body is
 * deferred until the runtime executes it, so nothing `execute` does and no
 * exception it raises can reach `update` - and a Command that `update` builds
 * and then discards runs nothing at all.
 *
 * ```ts
 * // No args
 * const Refresh = Command.define('Refresh', {
 *   messages: [CompletedRefresh],
 *   execute: refreshFeed.pipe(Effect.as(CompletedRefresh())),
 * })
 *
 * // With args
 * const FetchWeather = Command.define('FetchWeather', {
 *   args: { zipCode: Schema.String },
 *   messages: [SucceededFetchWeather, FailedFetchWeather],
 *   execute: ({ zipCode }) => Effect.gen(function* () {
 *     const weather = yield* Weather.fetch(zipCode)
 *     return SucceededFetchWeather({ weather })
 *   }),
 * })
 *
 * // Interruptible
 * const SaveDraft = Command.define('SaveDraft', {
 *   args: { draftId: Schema.String, body: Schema.String },
 *   messages: [SucceededSaveDraft, FailedSaveDraft],
 *   interrupt: true,
 *   execute: ({ draftId, body }) => save(draftId, body),
 * })
 *
 * SaveDraft({ draftId: 'abc', body })
 * SaveDraft.Interrupt(outcome => CompletedCancelSaveDraft({ outcome }))
 * ```
 */
/** A function's own `name` is read-only, so the Definition's is defined rather than assigned. */
const nameDefinition = <T extends object>(definition: T, name: string): T => {
  Object.defineProperty(definition, 'name', { value: name, configurable: true })
  return definition
}

export function define<const Name extends string, Fields extends Schema.Struct.Fields, const Messages extends ReadonlyArray<Schema.Top>, Eff extends Effect.Effect<Schema.Schema.Type<Messages[number]>, any, any>>(
  name: Name,
  config: Readonly<{
    args: Fields
    messages: Messages
    interrupt: InterruptOption<Schema.Schema.Type<Schema.Struct<Fields>>>
    execute: (args: Schema.Schema.Type<Schema.Struct<Fields>>) => Eff
  }>,
): InterruptibleDefinition<Name, Schema.Schema.Type<Schema.Struct<Fields>>, never, Eff>
export function define<const Name extends string, Fields extends Schema.Struct.Fields, const Messages extends ReadonlyArray<Schema.Top>, Eff extends Effect.Effect<Schema.Schema.Type<Messages[number]>, any, any>>(
  name: Name,
  config: Readonly<{
    args: Fields
    messages: Messages
    interrupt?: never
    execute: (args: Schema.Schema.Type<Schema.Struct<Fields>>) => Eff
  }>,
): CommandDefinitionWithArgs<Name, Fields, Eff>
export function define<const Name extends string, const Messages extends ReadonlyArray<Schema.Top>, Eff extends Effect.Effect<Schema.Schema.Type<Messages[number]>, any, any>>(
  name: Name,
  config: Readonly<{
    messages: Messages
    interrupt: true
    execute: Eff
  }>,
): InterruptibleDefinition<Name, Record<never, never>, Record<never, never>, Eff>
export function define<const Name extends string, const Messages extends ReadonlyArray<Schema.Top>, Eff extends Effect.Effect<Schema.Schema.Type<Messages[number]>, any, any>>(
  name: Name,
  config: Readonly<{ messages: Messages; interrupt?: never; execute: Eff }>,
): CommandDefinitionNoArgs<Name, Eff>
export function define(name: string, config: any): any {
  const { args: fields, messages, execute, interrupt } = config as any
  const hasArgs = fields !== undefined

  const build = (callArgs?: unknown): any => {
    // Deferred on purpose: `execute` runs when the runtime runs the Command,
    // never when `update` constructs one.
    const effect: Effect.Effect<any, any, any> = hasArgs ? execute(callArgs) : execute
    const command: any = {
      name,
      ...(hasArgs ? { args: callArgs as Record<string, unknown> } : {}),
      effect,
    }
    const key = keyFor(name, hasArgs ? (callArgs as Record<string, unknown>) : undefined, interrupt as InterruptOption<Record<string, unknown>>)
    if (key !== undefined) command.key = key
    return command
  }

  if (interrupt !== undefined) {
    const definition = nameDefinition(build, name) as unknown as { Interrupt: unknown }
    definition.Interrupt = interruptConstructor(name, interrupt)
    return definition
  }

  return nameDefinition(build, name)
}

/**
 * Transforms the Effect inside a Command, preserving its result Message, name
 * and args. Reach for this to provide a service, add a delay or a retry, or
 * change the error and requirement channel.
 */
export const mapEffect: {
  <A, E1, R1, E2, R2>(
    f: (effect: Effect.Effect<A, E1, R1>) => Effect.Effect<NoInfer<A>, E2, R2>,
  ): (command: Command<A, E1, R1>) => Command<A, E2, R2>
  <A, E1, R1, E2, R2>(
    command: Command<A, E1, R1>,
    f: (effect: Effect.Effect<A, E1, R1>) => Effect.Effect<NoInfer<A>, E2, R2>,
  ): Command<A, E2, R2>
} = Object.assign(
  <A, E1, R1, E2, R2>(command: Command<A, E1, R1>, f: (effect: Effect.Effect<A, E1, R1>) => Effect.Effect<NoInfer<A>, E2, R2>) => ({
    ...command,
    effect: f(command.effect),
    [MESSAGE_CHAIN]: chainOf(command),
  }),
  <A, E1, R1, E2, R2>(f: (effect: Effect.Effect<A, E1, R1>) => Effect.Effect<NoInfer<A>, E2, R2>) => (command: Command<A, E1, R1>) => ({
    ...command,
    effect: f(command.effect),
    [MESSAGE_CHAIN]: chainOf(command),
  }),
) as any

/**
 * Lifts a Command's result Message through `f`.
 *
 * `f` is fused into the Effect, so production dispatch is unchanged, and it is
 * also recorded on the Command. A test that resolves a lifted Command replays
 * the chain, so it sees the wrapped message without restating the wrapping by
 * hand.
 *
 * Never lift by hand with `Effect.map`, which dispatches correctly but is
 * invisible to a test: the test would see the child's raw message.
 *
 * The Command's `name` and `args` are preserved, so a trace still attributes it
 * to the Submodel that produced it.
 */
export const mapMessage: {
  <FromMessage, ToMessage, E = never, R = never>(
    command: Command<FromMessage, E, R>,
    f: (message: FromMessage) => ToMessage,
  ): Command<ToMessage, E, R>
  <FromMessage, ToMessage>(
    f: (message: FromMessage) => ToMessage,
  ): <E = never, R = never>(command: Command<FromMessage, E, R>) => Command<ToMessage, E, R>
} = Object.assign(
  <FromMessage, ToMessage, E = never, R = never>(command: Command<FromMessage, E, R>, f: (message: FromMessage) => ToMessage) =>
    withChain(
      {
        ...command,
        effect: Effect.map(command.effect, f as (m: FromMessage) => ToMessage),
      } as Command<ToMessage, E, R>,
      [...chainOf(command), f as (message: any) => any],
    ),
  <FromMessage, ToMessage>(f: (message: FromMessage) => ToMessage) =>
  <E = never, R = never>(command: Command<FromMessage, E, R>): Command<ToMessage, E, R> =>
    withChain(
      { ...command, effect: Effect.map(command.effect, f as (m: FromMessage) => ToMessage) } as Command<ToMessage, E, R>,
      [...chainOf(command), f as (message: any) => any],
    ),
) as any

/**
 * Lifts every Command in a batch through `f`. An absent list yields an empty
 * one, so `Command.mapMessages(commands, f)` composes over an optional
 * `commands` without a check at the call site.
 */
export const mapMessages: {
  <FromMessage, ToMessage, E = never, R = never>(
    commands: ReadonlyArray<Command<FromMessage, E, R>> | undefined,
    f: (message: FromMessage) => ToMessage,
  ): ReadonlyArray<Command<ToMessage, E, R>>
  <FromMessage, ToMessage>(
    f: (message: FromMessage) => ToMessage,
  ): <E = never, R = never>(commands: ReadonlyArray<Command<FromMessage, E, R>> | undefined) => ReadonlyArray<Command<ToMessage, E, R>>
} = Object.assign(
  <FromMessage, ToMessage, E = never, R = never>(
    commands: ReadonlyArray<Command<FromMessage, E, R>> | undefined,
    f: (message: FromMessage) => ToMessage,
  ): ReadonlyArray<Command<ToMessage, E, R>> => (commands ?? []).map((command) => mapMessage(command, f)),
  <FromMessage, ToMessage>(f: (message: FromMessage) => ToMessage) =>
  <E = never, R = never>(commands: ReadonlyArray<Command<FromMessage, E, R>> | undefined): ReadonlyArray<Command<ToMessage, E, R>> =>
    (commands ?? []).map((command) => mapMessage(command, f)),
) as any

/**
 * Runs a Command's recorded message lifts over a value, which is what a test
 * resolving a Command replays. Internal: an application resolves through
 * `Story.resolve` or `Scene.resolve`.
 */
export const __replayMessageChain = (command: Command<any, any, any>, value: unknown): unknown =>
  chainOf(command).reduce((message, lift) => lift(message), value)