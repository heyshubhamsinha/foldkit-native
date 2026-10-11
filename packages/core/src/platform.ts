import { Effect, Fiber, ManagedRuntime, Stream } from 'effect'
import { Engine, getFabricUIManager, nativePlatform, registerPlatformComponents } from '@ng-native/fabric'
import { createRenderer } from './renderer/fabricRenderer.js'
import type { Program, RuntimeHandle, RuntimeHost } from './runtime/runtime.js'

/**
 * The device host: the seam between the runtime and Fabric.
 *
 * The runtime knows about Messages, Models and a virtual tree. It does not know
 * that a `view` is a `UIView` on iOS and an `android.view.View` on Android, and
 * it never needs to. Everything platform-specific is in this file, which means
 * the runtime can be exercised in Node against a fake Fabric with no simulator,
 * and a third host - a screenshot renderer, a test harness - is one function
 * rather than a fork.
 *
 * The engine is reached through `global.nativeFabricUIManager`, which React
 * Native exposes on the new architecture and its own reconciler already uses.
 * `react-native` and `expo` are unmodified dependencies; nothing here is
 * forked.
 */

export interface NativeHostOptions {
  /** The Fabric surface to draw into. The app's own root view, by default. */
  readonly rootTag?: number
  /** The engine, when a host has already made one (a test, a nested app). */
  readonly engine?: Engine
  /** `Platform.OS`. iOS is the default, which is also what the engine assumes. */
  readonly platform?: 'ios' | 'android'
  readonly dev?: boolean
  /**
   * React Native's `processColor`, which turns a colour string into the integer
   * the platform wants. Without it a `*color` prop reaches native as the string
   * it was written as, and native draws nothing with it.
   */
  readonly processColor?: (value: string | number) => unknown
  /** Turns `require('./x.png')` - an asset *id* - into `{uri, width, height, scale}`. */
  readonly resolveAssetSource?: (value: unknown) => unknown
  /** The application-level stylesheet, compiled at build time. */
  readonly globalStyles?: unknown
  /** Pushed rather than read, so the engine imports nothing from React Native. */
  readonly conditions?: Record<string, unknown>
  readonly tokens?: Record<string, unknown>
  /** Called when the tree goes from clean to dirty, to schedule a commit. */
  readonly onDirty?: () => void
  /** Where an error thrown while a native event is being dispatched goes. */
  readonly onError?: (error: unknown, topLevelType: string) => void
  /** How long a press must be held before `onLongPress` fires. */
  readonly longPressDelay?: number
}

/** What a host that draws onto Fabric provides. */
export interface NativeSurface {
  readonly engine: Engine
  /** The tag of the root view everything is drawn into. */
  readonly rootTag: number
}

/**
 * Builds the Fabric surface a Foldkit Native program draws into.
 *
 * Call this once, at startup, before `run`. On a device the root tag is the
 * app's own root view; nothing is created here that React Native did not
 * already create.
 *
 * ```ts
 * const surface = mountNative({ rootTag: rootTag, platform: Platform.OS })
 * ```
 */
export const mountNative = (options: NativeHostOptions = {}): NativeSurface => {
  // Android names several components differently from iOS, and the engine holds
  // the table per platform, so this has to happen before the first element is
  // created rather than lazily on the first commit.
  if (options.platform !== undefined) registerPlatformComponents(options.platform)
  else registerPlatformComponents(nativePlatform() === 'android' ? 'android' : 'ios')

  const engine =
    options.engine ??
    new Engine(getFabricUIManager(), options.rootTag ?? 1, {
      dev: options.dev ?? false,
      now: () => Date.now(),
      ...(options.onDirty === undefined ? {} : { onDirty: options.onDirty }),
      ...(options.processColor === undefined ? {} : { processColor: options.processColor as never }),
      ...(options.resolveAssetSource === undefined ? {} : { resolveAssetSource: options.resolveAssetSource as never }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.globalStyles === undefined ? {} : { globalStyles: options.globalStyles as never }),
      ...(options.conditions === undefined ? {} : { conditions: options.conditions as never }),
      ...(options.tokens === undefined ? {} : { tokens: options.tokens as never }),
    })

  return { engine, rootTag: options.rootTag ?? 1 }
}

/**
 * Builds the runtime host for a surface.
 *
 * `dispatch` is wired to the live runtime's own `dispatch`, which the host
 * receives once `run` has started it. The indirection is deliberate: an event
 * prop can fire before the first render has finished, and a tap that arrives
 * during startup must reach `update` rather than be dropped.
 */
export const makeNativeHost = <Model, Msg extends { _tag: string }, Resources>(
  surface: NativeSurface,
  services: ManagedRuntime.ManagedRuntime<never, Resources>,
  options: { readonly dispatch: (message: Msg) => void; readonly longPressDelay?: number; readonly onError?: (error: unknown, message: string) => void },
): RuntimeHost<Model, Msg, Resources> => {
  const renderer = createRenderer({
    engine: surface.engine,
    dispatch: options.dispatch as (message: unknown) => void,
    ...(options.longPressDelay === undefined ? {} : { longPressDelay: options.longPressDelay }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })

  return {
    render: (vnode) => renderer.render(vnode),
    unmount: () => renderer.unmount(),
    // A Command's failure is its Message's business: `update` decides what an
    // error means, so the error channel is handed to it rather than raised here.
    runSync: <A>(effect: Effect.Effect<A, any, any>): A => services.runSync(effect as Effect.Effect<A, never, never>),
    fork: (effect) => services.runFork(effect as Effect.Effect<any, never, never>) as Fiber.Fiber<any, any>,
    // The Stream is drained into a fiber rather than collected: a subscription
    // runs for as long as the Model needs it, and its Messages arrive one at a
    // time by design.
    runStream: (stream) =>
      services.runFork(Stream.runForEach(stream, () => Effect.void) as Effect.Effect<never, never, never>) as Fiber.Fiber<any, any>,
    context: services.context,
  }
}

/**
 * Starts a program on a surface, in one call.
 *
 * The two halves - declaring the application and drawing it - are separate on
 * purpose, so this is the only place they meet. Everything else can be tested
 * without a surface at all.
 */
export const mountNativeProgram = <Model, Msg extends { _tag: string }, Resources>(
  program: Program<Model, Msg, Resources>,
  surface: NativeSurface,
  services: ManagedRuntime.ManagedRuntime<never, Resources>,
  options: { readonly longPressDelay?: number; readonly onError?: (error: unknown, message: string) => void } = {},
) => {
  let dispatch: (message: Msg) => void = () => {}
  const host = makeNativeHost<Model, Msg, Resources>(surface, services, {
    dispatch: (message) => dispatch(message),
    ...options,
  })
  const handle = program.start(host)
  dispatch = handle.dispatch
  return handle
}