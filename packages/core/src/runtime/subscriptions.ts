import { Duration, Effect, Equivalence, Schedule, Schema, Stream } from 'effect'

/**
 * Subscriptions: work whose lifetime comes from the Model.
 *
 * The problem they solve is the one Elm calls "the outside world". A location
 * watcher, a websocket, a push channel, a clock - none of them is started by a
 * fact and finished by a fact. They run while the Model says the thing they are
 * watching for is true, and they stop when it stops being true, and the decision
 * of when belongs in one place: the Model.
 *
 * ```ts
 * const subscriptions: Subscriptions<Model, Message> = {
 *   clock: Subscription.make({
 *     dependenciesSchema: Schema.Struct({ running: Schema.Boolean }),
 *     modelToDependencies: (model: Model) => ({ running: model.isRunning }),
 *     dependenciesToStream: ({ running }) =>
 *       running
 *         ? Stream.repeat(Effect.flatMap(Effect.sleep('1 second'), () => Effect.succeed(Message.Ticked())))
 *         : Stream.empty,
 *   }),
 * }
 * ```
 *
 * A subscription still cannot change state on its own. The stream does not
 * reach into the Model: it emits a fact, and `update` decides what that fact
 * means, exactly as it does for a tap. `Effect.sleep` is fine to reach for
 * because it runs in a fiber the runtime owns and can interrupt.
 *
 * After every transition the runtime recomputes each subscription's
 * dependencies and compares them with the ones its running Stream was started
 * with. Equivalent leaves it alone; a change tears it down and starts a new one.
 * So a watcher is never restarted because some unrelated part of the Model
 * changed - which is the whole reason the dependencies are declared separately
 * from the Model.
 */

/**
 * The brand field is `never`, so a `Subscription` cannot be constructed by hand:
 * it has to go through {@link make} or {@link persistent}, which is what keeps
 * the runtime's one assumption true of every value it sees.
 */
type SubscriptionBrand = { readonly __subscription: never }

const SUBSCRIPTION_BRAND: unique symbol = Symbol('foldkit-native.subscription') as never

/** The entry shape before branding. Pass it to {@link make}. */
export type EntryWithoutKeepAlive<Model, Message, Dependencies, Services> = {
  readonly dependenciesSchema: Schema.Schema<Dependencies> & { readonly fields: Schema.Struct.Fields }
  readonly modelToDependencies: (model: Model) => Dependencies
  readonly keepAliveEquivalence?: never
  readonly dependenciesToStream: (dependencies: Dependencies) => Stream.Stream<Message, never, Services>
}

/**
 * The entry shape for a Stream that should survive dependency changes.
 *
 * The running Stream is handed `readDependencies` so it can read the latest
 * values mid-flight. Reach for this only when a Stream genuinely needs data
 * that changes often but must not cause a restart; the default restart is both
 * simpler and correct more often.
 */
export type EntryWithKeepAlive<Model, Message, Dependencies, Services> = {
  readonly dependenciesSchema: Schema.Schema<Dependencies> & { readonly fields: Schema.Struct.Fields }
  readonly modelToDependencies: (model: Model) => Dependencies
  readonly keepAliveEquivalence: Equivalence.Equivalence<Dependencies>
  readonly dependenciesToStream: (
    dependencies: Dependencies,
    readDependencies: () => Dependencies,
  ) => Stream.Stream<Message, never, Services>
}

/**
 * One declared subscription.
 *
 * The brand field is `never`, so a `Subscription` value cannot be built by
 * hand: it has to go through {@link make} or {@link persistent}, which is what
 * keeps the runtime's one assumption - that `dependenciesSchema` is a
 * `Schema.Struct` naming every field it compares - true of every value it sees.
 */
export type Subscription<Model, Message, Dependencies, Services = never> = (
  | EntryWithoutKeepAlive<Model, Message, Dependencies, Services>
  | EntryWithKeepAlive<Model, Message, Dependencies, Services>
) &
  SubscriptionBrand

/** A record of named subscriptions. The runtime starts and stops each one on its own. */
export type Subscriptions<Model, Message, Services = never> = Readonly<
  Record<string, Subscription<Model, Message, any, Services>>
>

const brand = <T extends object>(entry: T): T & SubscriptionBrand =>
  Object.assign(entry, { __subscription: SUBSCRIPTION_BRAND }) as T & SubscriptionBrand

/**
 * Declares a subscription.
 *
 * `dependenciesSchema` must be a `Schema.Struct`, so every dependency is named
 * at the schema level rather than turning up in `modelToDependencies` by
 * accident. That is what makes the runtime's comparison total - it knows which
 * fields it is comparing - and a renamed dependency fails here rather than
 * silently never restarting.
 */
export const make = <Model, Message, Dependencies extends Record<string, any>, Services = never>(
  entry: EntryWithoutKeepAlive<Model, Message, Dependencies, Services>,
): Subscription<Model, Message, Dependencies, Services> => brand(entry as any)

/**
 * Declares a subscription whose Stream survives dependency changes.
 *
 * `keepAliveEquivalence` decides which Model changes are changes at all. The
 * Stream keeps running across them and reads the latest values through
 * `readDependencies`, so a stream that scrolls with a pointer can read a
 * pointer that moves every frame without being torn down sixty times a second.
 */
export const persistent = <Model, Message, Dependencies extends Record<string, any>, Services = never>(
  entry: EntryWithKeepAlive<Model, Message, Dependencies, Services>,
): Subscription<Model, Message, Dependencies, Services> => brand(entry as any)

/** Lifts a subscription's Messages through `f`, for a parent whose `update` folds a child's. */
export const lift =
  <FromMessage, ToMessage>(f: (message: FromMessage) => ToMessage) =>
  <Model, Message, Dependencies extends Record<string, any>, Services>(
    subscription: Subscription<Model, Message, Dependencies, Services>,
  ): Subscription<Model, ToMessage, Dependencies, Services> =>
    brand({
      dependenciesSchema: subscription.dependenciesSchema,
      modelToDependencies: subscription.modelToDependencies,
      ...('keepAliveEquivalence' in subscription ? { keepAliveEquivalence: subscription.keepAliveEquivalence } : {}),
      dependenciesToStream: (dependencies: any, readDependencies: any) =>
        Stream.map((subscription.dependenciesToStream as any)(dependencies, readDependencies), f),
    } as any)

/**
 * A subscription that emits a Message on an interval while its dependencies say it should.
 *
 * `while` is the part worth sharing. The runtime's rule is that it restarts a
 * Stream when its dependencies change - it cannot know whether a tick should
 * still happen - so the decision belongs here, written once, against the same
 * dependencies the restart is based on. A helper that ticked unconditionally
 * would keep ticking straight through a stop, which is the bug taking a
 * predicate makes impossible.
 *
 * ```ts
 * const clock = Subscription.interval<Model, Message>({
 *   dependenciesSchema: Schema.Struct({ isRunning: Schema.Boolean }),
 *   modelToDependencies: (model: Model) => ({ isRunning: model.isRunning }),
 *   every: '100 millis',
 *   while: ({ isRunning }) => isRunning,
 *   message: Message.Ticked(),
 * })
 * ```
 *
 * The Model says `isRunning: false`, the runtime restarts the Stream, `while`
 * says no, and the clock stops - with the decision visible in one place rather
 * than spread across a teardown path nobody remembers to write.
 */
export const interval = <
  Model,
  Message,
  Dependencies extends Record<string, any> = { isRunning: boolean },
  Services = never,
>(config: {
  readonly dependenciesSchema: Schema.Schema<Dependencies> & { readonly fields: Schema.Struct.Fields }
  readonly modelToDependencies: (model: Model) => Dependencies
  /** A Duration: `'1 second'`, `'250 millis'`, or a number of milliseconds. */
  readonly every: Duration.Input
  /** Whether the clock should be running, given the current dependencies. */
  readonly while: (dependencies: Dependencies) => boolean
  /** The fact each tick emits. Built once, because a tick carries no data. */
  readonly message: Message
}): Subscription<Model, Message, Dependencies, Services> =>
  brand({
    dependenciesSchema: config.dependenciesSchema,
    modelToDependencies: config.modelToDependencies,
    dependenciesToStream: (dependencies: Dependencies) =>
      config.while(dependencies)
        ? Stream.repeat(
            Stream.fromEffect(Effect.as(Effect.sleep(config.every as Duration.Input), config.message)),
            Schedule.spaced(config.every as Duration.Input),
          )
        : Stream.empty,
  }) as any
