/**
 * The renderer: a retained tree of native nodes, kept in step with the VNodes a
 * `view` returns.
 *
 * Fabric's tree is persistent. A committed node is never edited - it is cloned
 * with new props or new children, and a changed leaf forces every ancestor to
 * re-clone, because a persistent parent holds references to specific child
 * handles. The engine already owns that rule and does the cloning during
 * `commit()`; what it does not own is deciding *what* changed.
 *
 * That is this module. Between two renders it holds the previous tree beside the
 * new one, works out the smallest set of prop writes, insertions and removals
 * that turns one into the other, and hands the result to the engine. A view that
 * re-runs because one number changed costs one prop write rather than a new
 * tree - which is the difference between a counter and a list of a thousand rows
 * on a phone.
 *
 * A fragment is not a native node. It is folded away here, so a helper can
 * return several siblings without a wrapper view appearing on screen or a
 * placeholder in the tree.
 */

import { claimHost, type Engine, type EngineNode } from '@ng-native/fabric'
import { eventNameFor, type PressEvent } from '../view/elements.js'
import type { ElementVNode, TextVNode, VNode } from '../view/vnode.js'

/** What a mounted node keeps so the next render can be diffed against it. */
type MountedElement = {
  readonly kind: 'element'
  readonly vnode: ElementVNode
  readonly node: EngineNode
  /** The props as last written, so an unchanged one is not written again. */
  readonly props: Readonly<Record<string, unknown>>
  /** One teardown per bound event prop, keyed by prop name. */
  readonly listeners: Map<string, () => void>
  readonly children: ReadonlyArray<Mounted>
}

type MountedText = { readonly kind: 'text'; readonly vnode: TextVNode; readonly node: EngineNode }

type Mounted = MountedElement | MountedText

const isElementMounted = (mounted: Mounted): mounted is MountedElement => mounted.kind === 'element'

/**
 * How a Fabric event becomes the argument an event prop is called with.
 *
 * A handler is written against the thing it means - `onChange: (text) => ...`,
 * `onLayout: ({ width }) => ...` - not against a native event object nobody
 * outside React Native has the shape of. This table is the whole translation, and
 * it lives here rather than in an event prop's type so an application never has
 * to know that a native event exists.
 */
const PAYLOADS: Record<string, (nativeEvent: any) => unknown> = {
  onChange: (event) => event?.text ?? event?.value ?? '',
  onSubmitEditing: (event) => event?.text ?? '',
  onFocus: (event) => event?.text,
  onBlur: (event) => event?.text,
  onKeyPress: (event) => event?.key ?? '',
  onValueChange: (event) => event?.value,
  onSelectionChange: (event) => ({ start: event?.selection?.start ?? 0, end: event?.selection?.end ?? 0 }),
  onLayout: (event) => ({
    x: event?.layout?.x ?? 0,
    y: event?.layout?.y ?? 0,
    width: event?.layout?.width ?? 0,
    height: event?.layout?.height ?? 0,
  }),
  onScroll: (event) => ({
    contentOffset: event?.contentOffset,
    contentSize: event?.contentSize,
    layoutMeasurement: event?.layoutMeasurement,
  }),
  onContentSizeChange: (event) => ({ width: event?.width ?? 0, height: event?.height ?? 0 }),
  onEndReached: (event) => ({ contentOffset: event?.contentOffset }),
  onProgress: (event) => ({ loaded: event?.loaded ?? 0, total: event?.total ?? 0 }),
  onError: (event) => event?.message ?? String(event),
}

export interface RendererOptions {
  readonly engine: Engine
  /** Where an event prop's returned Message goes. */
  readonly dispatch: (message: unknown) => void
  /** How long a press must be held before `onLongPress` fires. */
  readonly longPressDelay?: number
  /** Reported when a handler returns something that is not a Message, or throws. */
  readonly onError?: (error: unknown, context: string) => void
}

export interface Renderer {
  /** Renders a tree, committing the difference from whatever is on screen. */
  render(vnode: VNode): void
  /** Takes the tree off the screen and releases every listener. */
  unmount(): void
  /** The native node a VNode's element maps to, for a test or an imperative command. */
  nodeFor(vnode: VNode): EngineNode | null
  /** Commit accounting, for a performance test. */
  readonly stats: { renders: number; created: number; commits: number }
}

export const createRenderer = (options: RendererOptions): Renderer => {
  const { engine, dispatch } = options
  const longPressDelay = options.longPressDelay ?? 500

  let root: Mounted | null = null
  let stats = { renders: 0, created: 0, commits: 0 }
  const byVNode = new WeakMap<VNode, Mounted>()

  const report = (error: unknown, context: string) => {
    if (options.onError) options.onError(error, context)
    else console.error(`[foldkit-native] ${context}`, error)
  }

  /** Calls an event prop and dispatches the Message it returned. */
  const fire = (handler: (payload: any) => unknown, payload: unknown) => {
    let message: unknown
    try {
      message = handler(payload)
    } catch (error) {
      report(error, 'an event handler threw')
      return
    }
    if (message === undefined || message === null) return
    // A handler that returns something else would dispatch a value no `match`
    // can handle, and the failure would surface far from the mistake.
    if (typeof (message as { _tag?: unknown })._tag !== 'string') {
      report(new Error(`An event handler must return a Message, but returned ${JSON.stringify(message)}`), 'bad event handler')
      return
    }
    dispatch(message)
  }

  const bind = (
    node: EngineNode,
    prop: string,
    handler: (payload: any) => unknown,
    listeners: Map<string, () => void>,
  ): void => {
    const read = PAYLOADS[prop]
    const payload = (event: any) => (read ? read(event?.nativeEvent ?? event) : (event?.nativeEvent ?? event))

    // `onPress` is not a Fabric event. It is the responder system - the same
    // negotiation React Native's own Pressable uses - so that a button inside a
    // scroll view agrees with the scroll view about who owns a drag, instead of
    // both acting on every touch.
    if (prop === 'onPress' || prop === 'onLongPress') {
      let timer: ReturnType<typeof setTimeout> | undefined
      let longFired = false
      const clear = () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      }
      listeners.set(
        prop,
        engine.setResponder(node, {
          onStartShouldSetResponder: () => true,
          onResponderGrant: (event) => {
            longFired = false
            clear()
            if (prop === 'onLongPress') {
              timer = setTimeout(() => {
                longFired = true
                fire(handler, event.nativeEvent as PressEvent)
              }, longPressDelay)
            }
          },
          onResponderRelease: (event) => {
            clear()
            if (prop === 'onPress' && !longFired) fire(handler, event.nativeEvent as PressEvent)
          },
          onResponderTerminate: () => {
            clear()
            // Terminated rather than released: the gesture was taken away, so
            // this is not a press the user completed.
            longFired = true
          },
        }),
      )
      return
    }

    const name = eventNameFor(prop)
    if (name === undefined) return
    listeners.set(prop, engine.setEventListener(node, name, (event) => fire(handler, payload(event))))
  }

  const unbindAll = (listeners: Map<string, () => void>): void => {
    for (const teardown of listeners.values()) teardown()
    listeners.clear()
  }

  /** Creates the native nodes for a list of VNodes and attaches them under `parent`. */
  const mountAll = (parent: EngineNode, vnodes: ReadonlyArray<VNode>): ReadonlyArray<Mounted> => {
    const mounted: Mounted[] = []
    for (const vnode of vnodes) {
      // A fragment renders as its children, with no node of its own.
      if (vnode.kind === 'fragment') {
        mounted.push(...mountAll(parent, vnode.children))
        continue
      }

      if (vnode.kind === 'text') {
        const node = engine.createText(vnode.value)
        engine.appendChild(parent, node)
        const entry: MountedText = { kind: 'text', vnode, node }
        byVNode.set(vnode, entry)
        mounted.push(entry)
        stats.created += 1
        continue
      }

      const node = engine.createElement(vnode.name)
      // The engine reports, on the first commit, any known element that no front
      // end has claimed. In Angular that catches a template which forgot to
      // import a component; here it would fire for every element the renderer
      // created, because claiming is something the components package does and
      // there is no components package. The renderer *is* the front end that
      // owns these elements - there is no template and no directive that could
      // have written one by hand - so it claims them here, once, at creation.
      claimHost(node)
      const listeners = new Map<string, () => void>()
      engine.appendChild(parent, node)

      for (const [prop, value] of Object.entries(vnode.props)) {
        // `key` is identity, not something to send to a native view.
        if (prop === 'key') continue
        if (value === undefined || value === null) continue
        if (prop.startsWith('on') && typeof value === 'function') {
          bind(node, prop, value as (payload: any) => unknown, listeners)
          continue
        }
        engine.setProp(node, prop, value)
      }

      const children = mountAll(node, vnode.children)
      const entry: MountedElement = { kind: 'element', vnode, node, props: vnode.props, listeners, children }
      byVNode.set(vnode, entry)
      mounted.push(entry)
      stats.created += 1
    }
    return mounted
  }

  /** Detaches a subtree and releases everything bound to it. */
  const unmountAll = (mounted: ReadonlyArray<Mounted>): void => {
    for (const entry of mounted) {
      if (isElementMounted(entry)) unbindAll(entry.listeners)
      byVNode.delete(entry.vnode)
      engine.removeChild(entry.node.parent, entry.node)
    }
  }

  /** Whether two VNodes may be patched into one another rather than replaced. */
  const sameElement = (mounted: Mounted, vnode: VNode): boolean => {
    if (mounted.vnode.kind !== vnode.kind) return false
    if (vnode.kind !== 'element' || mounted.vnode.kind !== 'element') return true
    return mounted.vnode.name === vnode.name && mounted.vnode.key === vnode.key
  }

  const patchElement = (mounted: MountedElement, vnode: ElementVNode): Mounted => {
    const { node, props: previous } = mounted
    const next = vnode.props

    // Props that went away. A removed event has to be unregistered rather than
    // written as `undefined`, because a native view would still hold the old
    // listener and keep dispatching Messages the view no longer returns.
    for (const prop of Object.keys(previous)) {
      if (prop === 'key' || prop in next) continue
      if (prop.startsWith('on') && typeof previous[prop] === 'function') {
        mounted.listeners.get(prop)?.()
        mounted.listeners.delete(prop)
        continue
      }
      engine.setProp(node, prop, undefined)
    }

    for (const [prop, value] of Object.entries(next)) {
      if (prop === 'key') continue
      const before = previous[prop]

      if (prop.startsWith('on') && typeof value === 'function') {
        // Identity is not the test here: `onPress: () => Message.X()` is a new
        // closure every render by construction, and comparing it would rebind
        // every listener on screen every frame. Rebinding is also what keeps the
        // handler from closing over a Model that has since changed.
        if (before !== value) {
          mounted.listeners.get(prop)?.()
          mounted.listeners.delete(prop)
          bind(node, prop, value as (payload: any) => unknown, mounted.listeners)
        }
        continue
      }

      if (Object.is(before, value)) continue
      engine.setProp(node, prop, value)
    }

    const entry: MountedElement = {
      kind: 'element',
      vnode,
      node,
      props: next,
      listeners: mounted.listeners,
      children: reconcileChildren(node, mounted.children, vnode.children),
    }
    byVNode.set(vnode, entry)
    return entry
  }

  /**
   * Matches old children to new ones.
   *
   * A keyed child is matched by key wherever it moved to, which is what keeps a
   * text input's cursor and a row's scroll position when an item above it is
   * removed. An unkeyed child is matched by position, so a plain list of
   * elements costs one pass and no bookkeeping.
   */
  const reconcileChildren = (
    parent: EngineNode,
    previous: ReadonlyArray<Mounted>,
    next: ReadonlyArray<VNode>,
  ): ReadonlyArray<Mounted> => {
    // Fragments are folded away before matching, so the algorithm below only
    // ever sees elements and text - one mounted node per VNode, always.
    const wanted: Array<VNode | null> = []
    const flatten = (vnodes: ReadonlyArray<VNode>): void => {
      for (const vnode of vnodes) {
        if (vnode.kind === 'fragment') flatten(vnode.children)
        else wanted.push(vnode)
      }
    }
    flatten(next)

    const result: Array<Mounted | null> = new Array(wanted.length).fill(null)
    const leftover = new Set(previous)

    const byKey = new Map<string, Mounted>()
    for (const entry of previous) {
      const key = entry.vnode.kind === 'element' ? entry.vnode.key : undefined
      if (key !== undefined) byKey.set(key, entry)
    }

    // First pass: a keyed child takes its match from anywhere in the old list.
    for (let index = 0; index < wanted.length; index += 1) {
      const vnode = wanted[index]!
      const key = vnode.kind === 'element' ? vnode.key : undefined
      if (key === undefined) continue
      const candidate = byKey.get(key)
      if (candidate === undefined || !leftover.has(candidate) || !sameElement(candidate, vnode)) continue
      byKey.delete(key)
      leftover.delete(candidate)
      result[index] = patch(parent, candidate, vnode)
    }

    // Second pass: whatever is left is matched by position.
    let cursor = 0
    for (let index = 0; index < wanted.length; index += 1) {
      if (result[index] !== null) continue
      const vnode = wanted[index]!
      while (cursor < previous.length) {
        const candidate = previous[cursor]!
        cursor += 1
        if (!leftover.has(candidate)) continue
        // A keyed old child is only ever matched by its key, never by position.
        if (candidate.vnode.kind === 'element' && candidate.vnode.key !== undefined) continue
        leftover.delete(candidate)
        if (sameElement(candidate, vnode)) result[index] = patch(parent, candidate, vnode)
        else unmountAll([candidate])
        break
      }
    }

    // Anything still unmatched is gone from the Model and comes off the screen.
    if (leftover.size > 0) unmountAll([...leftover])

    const mounted: Mounted[] = []
    for (let index = 0; index < wanted.length; index += 1) {
      mounted.push(result[index] ?? mountOne(parent, wanted[index]!))
    }

    // Order only when the order actually moved. Fabric re-parents on
    // `insertBefore`, so this is a real mutation and a list that merely
    // re-rendered should not pay for it.
    let inOrder = true
    for (let index = 0; index < mounted.length; index += 1) {
      if (parent.children[index] !== mounted[index]!.node) {
        inOrder = false
        break
      }
    }
    if (!inOrder) {
      // Backwards, because the engine's `insertBefore` detaches the node before
      // it looks up the reference: inserting a node *before its intended
      // successor* only lands in the right place if everything after it is
      // already where it belongs. A null reference means "append", so the last
      // child is placed first and the front falls out.
      for (let index = mounted.length - 1; index >= 0; index -= 1) {
        const child = mounted[index]!.node
        const successor = index === mounted.length - 1 ? null : mounted[index + 1]!.node
        if (child.parent !== parent || parent.children[index] !== child) engine.insertBefore(parent, child, successor)
      }
    }

    return mounted
  }

  const mountOne = (parent: EngineNode, vnode: VNode): Mounted => mountAll(parent, [vnode])[0]!

  const patch = (parent: EngineNode, mounted: Mounted, vnode: VNode): Mounted => {
    if (!sameElement(mounted, vnode)) {
      const next = mountOne(parent, vnode)
      unmountAll([mounted])
      return next
    }
    if (isElementMounted(mounted) && vnode.kind === 'element') return patchElement(mounted, vnode)
    if (mounted.kind === 'text' && vnode.kind === 'text') {
      if (mounted.vnode.value !== vnode.value) engine.setText(mounted.node, vnode.value)
      const entry: MountedText = { kind: 'text', vnode, node: mounted.node }
      byVNode.set(vnode, entry)
      return entry
    }
    return mounted
  }

  return {
    render: (vnode: VNode): void => {
      stats.renders += 1
      root = root === null ? mountAll(engine.root, [vnode])[0]! : patch(engine.root, root, vnode)
      if (engine.commit()) stats.commits += 1
    },
    unmount: (): void => {
      if (root !== null) unmountAll([root])
      root = null
      engine.commit()
    },
    nodeFor: (vnode) => byVNode.get(vnode)?.node ?? null,
    get stats() {
      return stats
    },
  }
}