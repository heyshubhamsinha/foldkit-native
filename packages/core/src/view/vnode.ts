/**
 * The native view tree: what a `view` function returns.
 *
 * A VNode is a plain, frozen description of one native element. It is not a
 * handle and not a live object: nothing in it points at a Fabric node, and
 * building a tree has no effect on the screen. That is what makes a `view`
 * function safe to call in a test with no engine at all, and what lets the
 * renderer diff two of them to decide the smallest commit.
 *
 * The shape is deliberately small - a name, props, children - because on the
 * other side of it is a persistent tree where a committed node is never
 * edited. Anything the renderer could not express as "this prop changed" or
 * "this child moved" would have to become a full remount of the subtree.
 */

export interface ElementVNode {
  readonly kind: 'element'
  /** The lowercase element name, e.g. `view`, `text-input`. Never a native view name. */
  readonly name: string
  readonly props: Readonly<Record<string, unknown>>
  readonly children: readonly VNode[]
  /**
   * Identity across renders. Two children with the same key are the same
   * element however they moved; two without one are matched by position. This
   * is what lets a list keep its input focus and scroll position when an item
   * above it is removed.
   */
  readonly key?: string
}

export interface TextVNode {
  readonly kind: 'text'
  readonly value: string
}

/** Groups children without adding a native view. Renders as nothing of its own. */
export interface FragmentVNode {
  readonly kind: 'fragment'
  readonly children: readonly VNode[]
}

export type VNode = ElementVNode | TextVNode | FragmentVNode

/** Anything `h` accepts where a child is expected. */
export type VNodeChild = VNode | string | number | boolean | null | undefined

/** A `view` function's return type. */
export type View = VNode

const isVNode = (value: unknown): value is VNode =>
  typeof value === 'object' && value !== null && typeof (value as VNode).kind === 'string'

/**
 * Normalises a child into a VNode, or nothing at all.
 *
 * A string, a number or a boolean becomes text; `null`, `undefined` and
 * `false` become nothing. That is why a view can write the condition inline:
 *
 * ```ts
 * h('view', null, isLoading ? h('text', null, 'Loading...') : null)
 * ```
 *
 * and why a list can be rendered with a plain `map`, with no key function and
 * no wrapper element for the empty case.
 */
export const toVNode = (child: VNodeChild): VNode | null => {
  if (child === null || child === undefined || typeof child === 'boolean') return null
  if (typeof child === 'string') return { kind: 'text', value: child }
  if (typeof child === 'number') return { kind: 'text', value: String(child) }
  if (Array.isArray(child)) return { kind: 'fragment', children: flattenChildren(child) }
  return isVNode(child) ? child : null
}

/** Normalises a child list, flattening fragments and dropping the empty ones. */
export const flattenChildren = (children: ReadonlyArray<VNodeChild>): readonly VNode[] => {
  const out: VNode[] = []
  for (const child of children) {
    const vnode = toVNode(child)
    if (vnode === null) continue
    if (vnode.kind === 'fragment') out.push(...vnode.children)
    else out.push(vnode)
  }
  return out
}

/** The key on a VNode, for keyed reconciliation. Only elements carry one. */
export const keyOf = (vnode: VNode): string | undefined => (vnode.kind === 'element' ? vnode.key : undefined)

/** True when two VNodes may be patched into one another rather than replaced. */
export const sameVNode = (a: VNode, b: VNode): boolean => {
  if (a.kind !== b.kind) return false
  if (a.kind !== 'element' || b.kind !== 'element') return true
  return a.name === b.name && a.key === b.key
}