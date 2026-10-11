import { Cause, Effect, Fiber, Layer, ManagedRuntime, Schema, Stream } from 'effect'
import type { Command } from '../command.js'
import { interruptRequestOf, type InterruptOutcome } from '../command.js'
import type { Return, ReturnWithOutMessage } from '../update.js'
import type { VNode } from '../view/vnode.js'
import type { NativeViewBuilder } from '../view/submodel.js'
import { createViewBuilder } from '../view/submodel.js'
import { Context } from 'effect'
import type { ManagedResources } from './managedResource.js'
import type { Subscription, Subscriptions } from './subscriptions.js'

/**
 * The runtime: the loop that turns Messages into a native screen.
 *
 * Everything in Foldkit Native follows from one rule - `update` is pure, so
 * something has to run the consequences - and this module is that something. It
 * is deliberately small and deliberately boring:
 *
 * 1. `init` produces the first Model, and a render puts it on screen.
 * 2. A Message arrives from somewhere - a tap, a Command's result, a
 *    subscription's tick.
 * 3. `update` runs, purely, and returns the next Model and the Commands it wants.
 * 4. The view is re-run, and the renderer commits only what changed.
 * 5. The Commands are forked, and whatever they produce comes back as more
 *    Messages, which go to step 2.
 *
 * Nothing else happens in between. There is no place for a side effect to hide,
 * which is what makes the whole application follow from a file of Messages and a
 * pure function - and what lets a Story test run steps 2 to 5 with no screen
 * at all.
 */

export type Message = { readonly _tag: string }

/** The configuration for a Foldkit Native application. */
export interface ApplicationConfig<Model, Msg extends Message, Resources = never> {
  /** The Schema for the whole application state. One immutable value. */
  readonly Model: Schema.Codec<Model, any, unknown, unknown>
  /** The starting state, and anything that should be running from the first frame. */
  readonly init: () => Return<Model, Msg, Resources>
  /** The transitions. Exhaustive over `Msg`: every fact has an answer. */
  readonly update: (model: Model, message: Msg) => Return<Model, Msg, Resources>
  /** A pure function of the Model. It draws nothing; it describes. */
  readonly view: (model: Model, h: NativeViewBuilder<Msg>) => VNode
  /** Work whose lifetime comes from the Model. */
  readonly subscriptions?: Subscriptions<Model, Msg, Resources>
  /** Services held for exactly as long as the Model needs them. */
  readonly managedResources?: ManagedResources<Model, Msg, Resources>
  /** Services the whole application can depend on. */
  readonly resources?: Layer.Layer<Resources>
  /** Reported when `update`, a view, or a Command fails. */
  readonly onError?: (error: unknown, phase: 'init' | 'update' | 'view' | 'command' | 'subscription' | 'resource') => void
}

/** A declared application. Pass it to {@link run} or {@link embed}. */
export interface Program<Model, Msg extends Message, Resources = never> {
  readonly config: ApplicationConfig<Model, Msg, Resources>
  readonly Model: Schema.Codec<Model, any, unknown, unknown>
  /** Starts the runtime against a host surface. Returns the handle that owns its lifetime. */
  readonly start: (host: RuntimeHost<Model, Msg, Resources>) => RuntimeHandle<Model, Msg>
}

/** What a host has to provide for the runtime to draw: the engine and the service runtime. */
export interface RuntimeHost<Model, Msg extends Message, Resources> {
  /** The value a `view` result is diffed against and committed to. */
  readonly render: (vnode: VNode) => void
  /** Releases every native node and listener. */
  readonly unmount: () => void
  /** Runs an Effect to a value with the application's services in scope. */
  readonly runSync: <A>(effect: Effect.Effect<A, any, any>) => A
  /** Forks a Command's Effect with the application's services in scope. */
  readonly fork: (effect: Effect.Effect<any, any, any>) => Fiber.Fiber<any, any>
  /** Forks a subscription's Stream with the application's services in scope. */
  readonly runStream: (stream: Stream.Stream<any, any, any>) => Fiber.Fiber<any, any>
  /** The services the host layer provided, if any. */
  readonly context?: unknown
  readonly Resources?: Resources
}

/** The handle a started runtime returns. */
export interface RuntimeHandle<Model, Msg extends Message> {
  /** The current Model. What DevTools shows and an MCP client reads. */
  readonly model: () => Model
  /** Every Message the runtime has dispatched, oldest first. */
  readonly log: () => ReadonlyArray<Msg>
  /** Puts a Message through `update`, exactly as a tap would. */
  readonly dispatch: (message: Msg) => void
  /** Stops everything: Commands, subscriptions, resources, listeners. */
  readonly dispose: () => void
}

/**
 * Declares an application.
 *
 * One declaration owns the Model, the Messages, `init`, `update` and `view`.
 * A five-file app and a fifty-file app have the same shape, and adding a feature
 * means adding a Message and an arm of one `match`.
 *
 * ```ts
 * const app = makeApplication<Model, Message>({
 *   Model,
 *   init: () => ({ model: { count: 0, isResetting: false, resetDuration: 2 } }),
 *   update,
 *   view,
 * })
 * ```
 */
export const makeApplication = <Model, Msg extends Message, Resources = never>(
  config: ApplicationConfig<Model, Msg, Resources>,
): Program<Model, Msg, Resources> => ({
  config,
  Model: config.Model,
  start: (host) => start(config, host),
})

/** A fiber that has been forked for a Command or a subscription. */
type Running = { readonly fiber: Fiber.Fiber<any, any>; readonly name: string }

export const start = <Model, Msg extends Message, Resources = never>(
  config: ApplicationConfig<Model, Msg, Resources>,
  host: RuntimeHost<Model, Msg, Resources>,
): RuntimeHandle<Model, Msg> => {
  const report = (error: unknown, phase: 'init' | 'update' | 'view' | 'command' | 'subscription' | 'resource') => {
    if (config.onError) config.onError(error, phase)
    else console.error(`[foldkit-native] ${phase} failed`, error)
  }

  const builder = createViewBuilder<Msg>()
  const log: Msg[] = []

  /**
   * In-flight Commands, by interrupt key.
   *
   * A key is an address, not a lock: any number of invocations may hold it at
   * once, which is what lets two searches run and the later one cancel only its
   * own.
   */
  const running = new Map<string, Set<Running>>()

  /** What each subscription was last started with, so a restart can be decided. */
  const subscriptionState = new Map<string, { readonly dependencies: unknown; readonly fiber: Fiber.Fiber<any, any> }>()
  /**
   * Managed resource instances currently held, by name.
   *
   * `key` is absent for a resource declared with `ManagedResource.lifecycle`,
   * which has no service to provide. Keeping the two in one map means the
   * acquire, the release and the provide all read the same set - a resource
   * cannot be released but still handed out, or provided without being held.
   */
  const heldResources = new Map<
    string,
    { readonly key?: Context.Key<string, any>; readonly service: unknown; readonly release: (service: any) => Effect.Effect<void, never, any> }
  >()

  let model: Model
  let disposed = false

  const render = (phase: 'init' | 'update' | 'view'): void => {
    try {
      host.render(config.view(model, builder))
    } catch (error) {
      report(error, phase === 'view' ? 'view' : phase)
    }
  }

  /**
   * Stops a fiber.
   *
   * `Fiber.interrupt` *returns* an Effect rather than interrupting on the spot,
   * so calling it and dropping the result stops nothing at all - a failure with
   * no error, because the code reads exactly as though it worked. Every caller
   * goes through the one place that runs it.
   */
  const interrupt = (fiber: Fiber.Fiber<any, any>): void => {
    try {
      host.fork(provideManaged(Fiber.interrupt(fiber)))
    } catch (error) {
      report(error, 'command')
    }
  }

  // --- Subscriptions -------------------------------------------------------

  /**
   * Compares a subscription's dependencies to decide whether its Stream keeps
   * running.
   *
   * Every field is named, so the comparison is total: a subscription that
   * depends on `{ running }` is not restarted because an unrelated counter in
   * the same Model changed.
   */
  const dependenciesEqual = (subscription: Subscription<Model, any, any, any>, a: unknown, b: unknown): boolean => {
    const fields = subscription.dependenciesSchema.fields as Record<string, any>
    if (subscription.keepAliveEquivalence) return subscription.keepAliveEquivalence(a as never, b as never)
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    for (const field of Object.keys(fields)) {
      if (!Object.is(left[field], right[field])) return false
    }
    return true
  }

  const reconcileSubscriptions = (): void => {
    const subscriptions = config.subscriptions
    if (subscriptions === undefined) return

    for (const [name, subscription] of Object.entries(subscriptions)) {
      const next = subscription.modelToDependencies(model)
      const current = subscriptionState.get(name)

      if (current !== undefined && dependenciesEqual(subscription, current.dependencies, next)) continue

      if (current !== undefined) {
        interrupt(current.fiber)
        subscriptionState.delete(name)
      }

      const build = () => {
        // `latest` is what a `persistent` subscription's Stream reads through
        // `readDependencies`, so it tracks the Model rather than the value the
        // Stream was started with.
        let latest = next
        const stream =
          'keepAliveEquivalence' in subscription && subscription.keepAliveEquivalence
            ? (subscription.dependenciesToStream as any)(next, () => latest)
            : (subscription.dependenciesToStream as any)(next)

        // The Stream does not reach into the Model. Every value it produces is a
        // Message, dispatched through the same queue a tap goes through, so
        // `update` decides what a tick means exactly as it decides what a press
        // means - and a subscription has no other route into the state.
        return host.runStream(
          provideManagedStream(
            Stream.map(stream, (message: any) => {
              latest = subscription.modelToDependencies(model)
              dispatch(message)
            }),
          ),
        )
      }

      try {
        subscriptionState.set(name, { dependencies: next, fiber: build() })
      } catch (error) {
        report(error, 'subscription')
      }
    }
  }

  // --- ManagedResources ---------------------------------------------------

  const reconcileResources = (): void => {
    const resources = config.managedResources
    if (resources === undefined) return

    for (const [name, resource] of Object.entries(resources)) {
      const wanted = resource.modelToEnabled(model)
      const held = heldResources.get(name)
      if (wanted && held === undefined) {
        try {
          const service = host.runSync(resource.acquire)
          heldResources.set(name, {
            service,
            release: resource.release as any,
            // `hasService: false` means there is nothing to hand out, so the key
            // is left off rather than provided as `undefined`.
            ...('key' in resource && resource.key !== undefined ? { key: resource.key } : {}),
          })
        } catch (error) {
          report(error, 'resource')
        }
      } else if (!wanted && held !== undefined) {
        if (resource.keepWhenDisabled !== true) {
          void releaseResource(name, held)
        }
      }
    }
  }

  /**
   * The Context every held resource contributes right now.
   *
   * Built fresh on each use rather than cached, which is what makes a release
   * effective immediately: a resource dropped from `heldResources` stops being
   * provided, so a Command that still asks for it fails as a missing service
   * rather than reading through a handle that has been closed.
   *
   * `Effect.provide` merges rather than replaces, so layering these over the
   * application's own `resources` layer keeps both.
   */
  const managedServices = (): Context.Context<never> | undefined => {
    if (heldResources.size === 0) return undefined
    let context: Context.Context<never> | undefined
    for (const held of heldResources.values()) {
      if (held.key === undefined) continue
      context = context === undefined ? Context.add(Context.empty(), held.key, held.service) : Context.add(context, held.key, held.service)
    }
    return context
  }

  /**
   * Gives an Effect the services the Model currently holds.
   *
   * The single place a managed service reaches anything. Commands, subscriptions
   * and releases all go through it, so there is one answer to "what is
   * provided" rather than one per call site - and a fourth caller added later
   * gets the behaviour rather than having to remember it.
   */
  const provideManaged = <A>(effect: Effect.Effect<A, any, any>): Effect.Effect<A, any, any> => {
    const context = managedServices()
    return context === undefined ? effect : Effect.provide(effect, context)
  }

  /** The same, for a Stream. `Effect.provide` does not take one, so this has its own. */
  const provideManagedStream = (stream: Stream.Stream<any, any, any>): Stream.Stream<any, any, any> => {
    const context = managedServices()
    return context === undefined ? stream : Stream.provideContext(stream, context)
  }

  const releaseResource = (
    name: string,
    held: { readonly service: unknown; readonly release: (service: any) => Effect.Effect<void, never, any> },
  ): void => {
    heldResources.delete(name)
    try {
      // Detached: a release interrupted by a second unmount would leak the
      // resource it was closing.
      void host.fork(provideManaged(held.release(held.service) as Effect.Effect<void, never, never>))
    } catch (error) {
      report(error, 'resource')
    }
  }

  // --- Commands -----------------------------------------------------------

  /** Runs one Command's Effect and dispatches the Message it produced. */
  const runCommand = (command: Command<any, any, any>): void => {
    if (disposed) return

    const request = interruptRequestOf(command)
    if (request !== undefined) {
      // The only thing that stops a Command is `update` returning this. Dispatch
      // never interrupts, which is what keeps "cancel" a visible decision.
      const holders = request.keyArgs === undefined ? running.get(request.target) : undefined
      const matched = holders ?? new Set<Running>()
      if (request.keyArgs !== undefined) {
        const key = `${request.target}:${Object.values(request.keyArgs).join(':')}`
        const keyed = running.get(key)
        if (keyed !== undefined) for (const running_ of keyed) matched.add(running_)
      }

      // Any holder that has not already been interrupted counts as stopped.
      // `Fiber.interrupt` is idempotent, so interrupting a completed fiber is
      // harmless and does not need its own check.
      let interrupted = false
      for (const entry of matched) {
        interrupt(entry.fiber)
        interrupted = true
      }
      dispatch(request.toMessage(interrupted ? ({ _tag: 'Interrupted' } as InterruptOutcome) : ({ _tag: 'NotFound' } as InterruptOutcome)))
      return
    }

    const effect = Effect.flatMap(command.effect, (message: any) =>
      Effect.sync(() => {
        if (!disposed && message !== undefined && message !== null) dispatch(message)
      }),
    )

    const key = command.key

    // The registry entry is removed when the Command exits, however it exits -
    // a value, a failure, or an interruption. Without that, a Command run ten
    // thousand times over a long session leaves ten thousand dead fibers behind,
    // and every `Interrupt` after that pays for all of them.
    const token: { fiber?: Fiber.Fiber<any, any> } = { fiber: undefined }
    const body =
      key === undefined
        ? effect
        : Effect.onExit(effect, () => Effect.asVoid(Effect.sync(() => running.get(key!)?.delete(token as unknown as Running))))

    let fiber: Fiber.Fiber<any, any>
    try {
      fiber = host.fork(provideManaged(body))
    } catch (error) {
      report(error, 'command')
      return
    }
    token.fiber = fiber

    if (key !== undefined) {
      const holders = running.get(key)
      const entry: Running = { fiber, name: command.name }
      if (holders === undefined) running.set(key, new Set([entry]))
      else holders.add(entry)
    }
  }

  const runCommands = (commands: ReadonlyArray<Command<any, any, any>> | undefined): void => {
    if (commands === undefined) return
    for (const command of commands) runCommand(command)
  }

  // --- The loop -----------------------------------------------------------

  /**
   * Messages waiting to go through `update`.
   *
   * A queue rather than a recursive call, because a Command completing can
   * dispatch while the runtime is already dispatching. Re-entering `update`
   * there would interleave two transitions on one Model.
   */
  const queue: Msg[] = []
  let draining = false

  function dispatch(message: Msg): void {
    if (disposed) return
    queue.push(message)
    if (draining) return
    draining = true
    try {
      while (queue.length > 0 && !disposed) apply(queue.shift()!)
    } finally {
      draining = false
    }
  }

  const apply = (message: Msg): void => {
    log.push(message)
    let result: ReturnWithOutMessage<Model, Msg, any, Resources>
    try {
      result = config.update(model, message) as ReturnWithOutMessage<Model, Msg, any, Resources>
    } catch (error) {
      report(error, 'update')
      return
    }
    model = result.model

    if (result.outMessage !== undefined) {
      // An application's own OutMessage has no parent to report to. A Submodel
      // folds it into its parent's `update`; at the top level it is a fact the
      // application decided to surface and nothing is listening.
      void result.outMessage
    }

    reconcileResources()
    render('update')
    reconcileSubscriptions()
    runCommands(result.commands)
  }

    // --- Start --------------------------------------------------------------

  const initial = config.init()
  model = initial.model

  reconcileResources()
  render('init')
  reconcileSubscriptions()
  runCommands(initial.commands)

  return {
    model: () => model,
    log: () => log,
    dispatch,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const holders of running.values()) for (const entry of holders) interrupt(entry.fiber)
      running.clear()
      for (const state of subscriptionState.values()) interrupt(state.fiber)
      subscriptionState.clear()
      for (const [name, held] of heldResources) releaseResource(name, held)
      host.unmount()
    },
  }
}

/**
 * Starts a Foldkit Native program against a host surface.
 *
 * On a device this is the whole entry point:
 *
 * ```ts
 * import { run } from 'foldkit-native'
 * import { mountNative } from 'foldkit-native/platform'
 * import { app } from './app'
 *
 * run(app, { host: mountNative() })
 * ```
 *
 * In a test it is the same call with a fake surface, which is why the two look
 * identical: a Story test is not a different program, it is a program with a
 * host that draws nothing.
 */
export const run = <Model, Msg extends Message, Resources = never>(
  program: Program<Model, Msg, Resources>,
  host: RuntimeHost<Model, Msg, Resources>,
): RuntimeHandle<Model, Msg> => program.start(host)

/** The service runtime a host builds the application's Layer into. */
export const makeRuntime = <Resources>(layer: Layer.Layer<Resources> | undefined): ManagedRuntime.ManagedRuntime<never, Resources> =>
  ManagedRuntime.make((layer ?? Layer.empty) as Layer.Layer<Resources>)

export { Cause, Fiber, Layer, ManagedRuntime } from 'effect'