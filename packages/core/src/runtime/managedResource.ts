import { Context, Effect } from 'effect'

/**
 * ManagedResources: a service held for exactly as long as the Model needs it.
 *
 * The difference from a Subscription is ownership. A Subscription streams
 * Messages and holds nothing the Model has to release; a ManagedResource hands
 * out a *service* - a socket, an audio context, a database handle, a location
 * watcher - and holds it open while some part of the Model is true.
 *
 * ```ts
 * class Database extends ManagedResource.Service<DatabaseApi>()('app/Database') {}
 *
 * const managedResources = {
 *   db: ManagedResource.make({
 *     key: Database,
 *     modelToEnabled: (model: Model) => model.isConnected,
 *     acquire: Effect.sync(() => openConnection()),
 *     release: (db) => db.close(),
 *   }),
 * }
 * ```
 *
 * The runtime acquires when `modelToEnabled` turns true, provides the service
 * under `key` to every Command and subscription that asks for it, and releases
 * it when the Model turns false or the app unmounts. So "stop the music" is a
 * field on the Model, not a `finally` block nobody remembers to write.
 *
 * `key` is required, and that is the whole design. A resource that acquired
 * something and could not say under what name would hold a handle no Command
 * could ever reach: the acquire and release would both run, the code would look
 * finished, and the service would be unreachable. Naming the key is what makes
 * "provides the service" a checkable statement rather than an aspiration. A
 * resource that genuinely has no service - a camera warm-up, a permission
 * prompt, a teardown that exists only for its timing - is declared with
 * {@link lifecycle} instead, which has no key because there is nothing to hand
 * out.
 *
 * Acquire and release are ordinary Effects, so a release interrupted by a second
 * unmount still runs: the runtime forks it detached rather than inline.
 */

/** The Context key a service is provided under. */
export type ServiceKey<Services> = Context.Key<any, Services>

/** One declared managed resource. */
export interface ManagedResource<Model, Message, Services = never> {
  /**
   * What the acquired value is provided under.
   *
   * A Command that asks for this key gets this resource's service, and only
   * while the Model keeps the resource enabled - a Command run after the Model
   * dropped it fails as a missing service rather than reading through a handle
   * that has been closed.
   */
  readonly key: ServiceKey<Services>
  /** Whether the Model currently needs the resource. Read after every transition. */
  readonly modelToEnabled: (model: Model) => boolean
  /** Opens the resource. Its value is the service every consumer sees. */
  readonly acquire: Effect.Effect<Services, never, any>
  /** Closes it. Run when the Model stops needing it, and on unmount. */
  readonly release: (service: Services) => Effect.Effect<void, never, any>
  /**
   * Whether the resource stays open across a transition where `modelToEnabled`
   * was false. False - the default - closes it. True is for something whose
   * teardown is expensive enough that re-opening it would be visible, such as a
   * video session the user expects to resume.
   */
  readonly keepWhenDisabled?: boolean
  /** For DevTools, and for an error message that names the right module. */
  readonly name?: string
}

/** A resource with a service, provided to Commands under `key`. */
export interface WithService<Model, Message, Services = any> extends ManagedResource<Model, Message, Services> {
  readonly hasService: true
}

/** What `lifecycle` accepts: the same shape, minus `hasService`, which it adds. */
export interface LifecycleConfig<Model, Message> {
  readonly modelToEnabled: (model: Model) => boolean
  readonly acquire: Effect.Effect<void, never, any>
  readonly release: () => Effect.Effect<void, never, any>
  readonly keepWhenDisabled?: boolean
  readonly name?: string
}

/** A resource with no service: acquire and release exist for their timing. */
export interface Lifecycle<Model, Message> extends LifecycleConfig<Model, Message> {
  readonly hasService: false
  readonly key?: undefined
}

/** Either kind. The runtime reads `hasService` to know whether there is anything to provide. */
export type Any<Model, Message> = WithService<Model, Message, any> | Lifecycle<Model, Message>

/** A record of named resources. The runtime manages each one on its own. */
export type ManagedResources<Model, Message, Services = never> = Readonly<
  Record<string, Any<Model, Message>>
>

type ResourceBrand = { readonly __managedResource: never }

const RESOURCE_BRAND: never = Symbol('foldkit-native.managedResource') as never

/** A branded resource, so only {@link make} or {@link lifecycle} can produce one. */
export type Tagged<Model, Services> = WithService<Model, never, Services> & ResourceBrand

const brand = <T extends object>(entry: T): T & ResourceBrand =>
  Object.assign(entry, { __managedResource: RESOURCE_BRAND }) as T & ResourceBrand

/**
 * Declares a managed resource that provides a service.
 *
 * `key` is the Context key the service is provided under, and it is what a
 * Command names when it asks for the service. Declaring both halves together is
 * the point: a resource and the Commands that use it cannot drift apart,
 * because the key is the same name in both.
 *
 * ```ts
 * class Audio extends ManagedResource.Service<AudioContext>()('app/Audio') {}
 *
 * const audio = ManagedResource.make<Model, Message, AudioContext>({
 *   key: Audio,
 *   modelToEnabled: (model: Model) => model.isPlaying,
 *   acquire: Effect.sync(() => new AudioContext()),
 *   release: (context) => Effect.sync(() => context.close()),
 * })
 *
 * // A Command that needs it names the same key, and the runtime fills it in
 * // exactly while the Model keeps the resource enabled.
 * const Play = Command.define('Play', {
 *   messages: [CompletedPlay],
 *   execute: Effect.as(Effect.flatMap(Effect.service(Audio), (context) => context.play()), CompletedPlay()),
 * })
 * ```
 */
export const make = <Model, Message, Services>(resource: ManagedResource<Model, Message, Services>): WithService<Model, Message, Services> =>
  brand({ ...resource, hasService: true as const })

/**
 * Declares a managed resource with no service.
 *
 * For work whose Model-derived lifetime is the point but which hands nothing
 * back: a permission prompt to re-ask when the Model stops being answered, a
 * warm-up to undo, a timer to clear. The acquire and release still run on the
 * Model's schedule, which is the part worth having; there is simply nothing for
 * a Command to ask for, so there is no key to name.
 *
 * ```ts
 * const managedResources = {
 *   location: ManagedResource.lifecycle<Model, Message>({
 *     modelToEnabled: (model) => model.needsLocation,
 *     acquire: Effect.promise(() => Geolocation.requestPermission()),
 *     release: () => Effect.void,
 *   }),
 * }
 * ```
 */
export const lifecycle = <Model, Message>(resource: LifecycleConfig<Model, Message>): Lifecycle<Model, Message> =>
  brand({ ...resource, hasService: false as const }) as Lifecycle<Model, Message>

/** The error the runtime reports when a Command needs a resource the Model does not enable. */
export class ResourceNotAvailable extends Error {
  readonly _tag = 'ResourceNotAvailable'
  constructor(readonly resource: string) {
    super(`ManagedResource '${resource}' is not enabled by the Model, so it has no service to provide.`)
    this.name = 'ResourceNotAvailable'
  }
}

/**
 * Declares the key a resource's service is provided under.
 *
 * Effect's own `Context.Service` under a shorter name, because depending on a
 * resource by type rather than by string is what keeps a Command's `R` honest:
 * the requirement appears in its type, so a Command that needs the audio
 * context cannot be written without it showing up in what the runtime provides.
 *
 * ```ts
 * class Audio extends ManagedResource.Service<AudioContext>()('app/Audio') {}
 * ```
 */
export const Service = <Self>(key: string) => Context.Service<any, Self>(key)

export { Context } from 'effect'