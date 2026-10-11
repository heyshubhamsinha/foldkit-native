import { Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect'
import type { Message, RuntimeHost } from '../src/runtime/runtime.js'
import type { VNode } from '../src/view/vnode.js'

/**
 * A headless host, for tests that need a runtime without a screen.
 *
 * The runtime does not know about Fabric; it knows it renders a VNode into
 * something and forks Effects. This is that something. A test runs the real loop
 * - real `init`, real `update`, real Commands, real subscriptions - and only the
 * drawing is replaced, by a tree of plain objects a test can read and press.
 */

/** A node in the headless tree. Mirrors what the renderer would commit. */
export interface TestNode {
  readonly kind: 'element' | 'text'
  readonly name: string
  readonly props: Record<string, unknown>
  readonly children: TestNode[]
  /** The event props on this node, so a Scene test can press something. */
  readonly handlers: Record<string, (payload: any) => unknown>
}

export interface TestHost<Model, Msg extends Message, Resources = never> {
  /** The current tree, after the last render. */
  readonly tree: () => TestNode | null
  /** How many times `view` has run. */
  readonly renders: () => number
  /** Finds the first node with this `testID`. */
  readonly byTestId: (testID: string) => TestNode | null
  /** Every node with this accessibility label. */
  readonly byLabel: (label: string) => TestNode[]
  /** All text in the tree, concatenated, as a screen reader would read it. */
  readonly text: () => string
  /** Every node, root first. */
  readonly all: () => TestNode[]
  /** Fires an event prop and dispatches the Message it returns, as the renderer does. */
  readonly fire: (node: TestNode, prop: string, payload?: unknown) => void
  readonly services: ManagedRuntime.ManagedRuntime<never, Resources>
  /** The host the runtime is started against, bound to `dispatch`. */
  hostFor(dispatch: (message: Msg) => void): RuntimeHost<Model, Msg, Resources>
}

/** Builds the tree the runtime's VNode describes, as plain data. */
const build = (vnode: VNode): TestNode => {
  if (vnode.kind === 'text') return { kind: 'text', name: '#text', props: { text: vnode.value }, children: [], handlers: {} }
  // `buildChildren` above is what flattens fragments, so anything reaching here
  // is an element. The check keeps that honest rather than trusting the caller.
  if (vnode.kind === 'fragment') return buildChildren(vnode)[0] ?? { kind: 'element', name: '#fragment', props: {}, children: [], handlers: {} }

  const children: TestNode[] = []
  for (const child of vnode.children) children.push(...buildChildren(child))

  const props: Record<string, unknown> = {}
  const handlers: Record<string, (payload: any) => unknown> = {}
  for (const [key, value] of Object.entries(vnode.props)) {
    // `key` is identity, not something the view ever reads.
    if (key === 'key') continue
    if (key.startsWith('on') && typeof value === 'function') {
      handlers[key] = value as (payload: any) => unknown
      continue
    }
    props[key] = value
  }

  return { kind: 'element', name: vnode.name, props, children, handlers }
}

/** Builds one child, flattening a fragment into the parent's own child list. */
const buildChildren = (vnode: VNode): TestNode[] =>
  vnode.kind === 'fragment' ? vnode.children.flatMap(buildChildren) : [build(vnode)]

/** Every node in the tree, root first. */
const walk = (node: TestNode | null): TestNode[] => {
  if (node === null) return []
  return [node, ...node.children.flatMap(walk)]
}

/** The text a screen reader would read for this subtree. */
const textOf = (node: TestNode): string => {
  if (node.kind === 'text') return String(node.props['text'] ?? '')
  return node.children.map(textOf).join('')
}

export const createTestHost = <Model, Msg extends Message, Resources = never>(
  layer?: Layer.Layer<Resources>,
): TestHost<Model, Msg, Resources> => {
  const services = ManagedRuntime.make((layer ?? Layer.empty) as Layer.Layer<Resources>)
  let tree: TestNode | null = null
  let renders = 0

  /**
   * Late-bound on purpose.
   *
   * The runtime dispatches into the host through this reference, and the host
   * does not have it until the runtime has started - which is exactly the
   * situation `makeNativeHost` is in on a device. An event prop can fire during
   * the first render, so closing over a dispatch that does not exist yet would
   * drop the first tap.
   */
  let dispatch: (message: Msg) => void = () => {}

  const hostFor = (connect: (message: Msg) => void): RuntimeHost<Model, Msg, Resources> => {
    dispatch = connect
    return {
      render: (vnode: VNode) => {
        renders += 1
        tree = build(vnode)
      },
      unmount: () => {
        tree = null
      },
      runSync: <A,>(effect: Effect.Effect<A, any, any>): A => services.runSync(effect as Effect.Effect<A, never, never>),
      fork: (effect: Effect.Effect<any, any, any>): Fiber.Fiber<any, any> =>
        services.runFork(effect as Effect.Effect<any, never, never>) as Fiber.Fiber<any, any>,
      // Drained into a fiber: a subscription runs for as long as the Model needs
      // it, and it dispatches each value through the runtime's own queue rather
      // than collecting them.
      runStream: (stream: Stream.Stream<any, any, any>): Fiber.Fiber<any, any> =>
        services.runFork(Stream.runDrain(stream) as unknown as Effect.Effect<never, never, never>) as Fiber.Fiber<any, any>,
    }
  }

  return {
    tree: () => tree,
    renders: () => renders,
    all: () => walk(tree),
    byTestId: (testID) => walk(tree).find((node) => node.props['testID'] === testID) ?? null,
    byLabel: (label) => walk(tree).filter((node) => node.props['accessibilityLabel'] === label),
    text: () => (tree === null ? '' : textOf(tree)),
    // The same three steps the renderer performs: call the handler, check what
    // came back is a Message, dispatch it. Anything less would let a test pass
    // against a path the device never takes.
    fire: (node, prop, payload) => {
      const handler = node.handlers[prop]
      if (handler === undefined) throw new Error(`<${node.name}> has no '${prop}' handler`)
      const message = handler(payload)
      if (message === undefined || message === null) return
      if (typeof (message as { _tag?: unknown })._tag !== 'string') {
        throw new Error(`An event handler must return a Message, but returned ${JSON.stringify(message)}`)
      }
      dispatch(message as Msg)
    },
    hostFor,
    services,
  }
}

/**
 * Starts a program against a headless host.
 *
 * The same call a device makes, with a host that draws nothing, which is the
 * point: a headless test is not a different program, it is this program with a
 * different surface.
 */
export const startHeadless = <Model, Msg extends Message, Resources = never>(
  program: {
    readonly start: (
      host: RuntimeHost<Model, Msg, Resources>,
    ) => {
      dispatch: (message: Msg) => void
      dispose: () => void
      model: () => Model
      log: () => ReadonlyArray<Msg>
    }
  },
  host: TestHost<Model, Msg, Resources>,
) => {
  let connect: (message: Msg) => void = () => {}
  const handle = program.start(host.hostFor((message: Msg) => connect(message)))
  connect = handle.dispatch
  return handle
}

/** Yields to the macrotask queue, so a forked Command's first steps have run. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits `ms` of real time, for a Command that sleeps. */
export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))