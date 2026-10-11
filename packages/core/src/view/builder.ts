import { flattenChildren, type ElementVNode, type FragmentVNode, type TextVNode, type VNode, type VNodeChild } from './vnode.js'
import type { NativeBuilder, NativeElementName } from './elements.js'

/**
 * `h`: the one function a view uses to describe native UI.
 *
 * It is passed to `view` rather than imported so that the Message type flows
 * from the runtime into the props. An event handler is typed `(payload) =>
 * Message`, which means the Message a tap produces is checked at the call site
 * where it is written - `onPress: () => Message.ClickedIncrement()` fails to
 * typecheck if `ClickedIncrement` does not exist - and an event prop carrying
 * something that is not a Message fails too. A `view` therefore cannot invent
 * state changes that `update` does not handle.
 *
 * ```ts
 * const view = (model: Model, h: NativeBuilder<Message>) =>
 *   h('safe-area-view', { style: styles.screen },
 *     h('text', { style: styles.count }, String(model.count)),
 *     h('pressable', {
 *       style: styles.button,
 *       accessibilityRole: 'button',
 *       onPress: () => Message.ClickedIncrement(),
 *     }, h('text', { style: styles.label }, 'Increment')),
 *   )
 * ```
 *
 * `view` is a pure function of the Model. It is called on every transition,
 * and calling it has no effect on the screen: the renderer diffs what it
 * returns against what is already there and commits the difference. That is
 * what lets a Story test call it with no engine at all.
 */

const build = <Message, Name extends string>(
  name: Name,
  props: Readonly<Record<string, unknown>> | null | undefined,
  children: ReadonlyArray<VNodeChild>,
): ElementVNode => {
  const flattened = flattenChildren(children)
  // `key` is lifted out of the props: it is identity, not something to send to
  // the native view, and the reconciler reads it before anything else.
  const key = props !== null && props !== undefined && typeof props['key'] === 'string' ? props['key'] : undefined
  return {
    kind: 'element',
    name,
    props: props ?? {},
    children: flattened,
    ...(key === undefined ? {} : { key }),
  }
}

/**
 * Builds the `h` a view is given.
 *
 * Every view call gets its own, so `Message` is inferred per application and a
 * view can be checked against the Message union it is actually paired with.
 */
export const createBuilder = <Message>(): NativeBuilder<Message> => {
  const builder = (<Name extends NativeElementName>(
    name: Name,
    props?: Readonly<Record<string, unknown>> | null,
    ...children: VNodeChild[]
  ): ElementVNode => build<Message, Name>(name, props ?? null, children)) as NativeBuilder<Message>

  const withText = (value: string | number): TextVNode => ({ kind: 'text', value: String(value) })
  const withFragment = (...children: VNodeChild[]): FragmentVNode => ({ kind: 'fragment', children: flattenChildren(children) })

  return Object.assign(builder, { text: withText, fragment: withFragment }) as NativeBuilder<Message>
}

/** A standalone `h`, for a view built outside the runtime (a test, a Story). */
export const h: NativeBuilder<never> = createBuilder<never>()

/**
 * Wraps a tree in a fragment, so a helper can return several siblings where the
 * caller expects one. Renders as nothing of its own.
 */
export const fragment = (...children: VNodeChild[]): FragmentVNode => ({ kind: 'fragment', children: flattenChildren(children) })

/** A text node, for a view that computes its content before reaching for `h`. */
export const text = (value: string | number): TextVNode => ({ kind: 'text', value: String(value) })

export type { VNode, VNodeChild, ElementVNode, TextVNode, FragmentVNode }