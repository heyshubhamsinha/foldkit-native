import type { Schema } from 'effect'
import { createBuilder } from './builder.js'
import type { NativeBuilder } from './elements.js'
import type { ElementVNode, VNode } from './vnode.js'
import type { Return, ReturnWithOutMessage } from '../update.js'
import type { ManagedResources } from '../runtime/managedResource.js'
import type { Subscriptions } from '../runtime/subscriptions.js'

/**
 * Submodels: a Model inside a Model.
 *
 * A Submodel is a module that owns a slice of the state, its own Messages and
 * its own transitions, and is embedded in a larger program by two declarations:
 * `Update.foldChild` for the state half and `h.submodel` for the view half.
 *
 * The point is not file size. It is that the child's transitions stay in the
 * child. A counter that resets after a delay has four Messages and a Command
 * with an interruption; embedding it in a settings screen and a checkout screen
 * should not make either screen know any of that. The parent gains one slice of
 * Model and one Message that says "something happened in the counter", and the
 * child's module keeps saying what actually happened.
 *
 * ```ts
 * // counter.ts
 * export const Counter = Submodel.define({
 *   Model: Schema.Struct({ count: Schema.Number, isResetting: Schema.Boolean }),
 *   init: () => ({ model: { count: 0, isResetting: false } }),
 *   update: (model, message) => Message.match<Update.Return<Model, Message>>(message, { ... }),
 *   view: (model, h) => h('view', null, h('text', null, String(model.count))),
 * })
 *
 * // app.ts
 * const foldCounter = Update.foldChild({
 *   update: Counter.update,
 *   read: (model: Model) => Option.some(model.counter),
 *   write: (model, next) => modifyFields(model, { counter: () => next }),
 *   toParentMessage: message => GotCounterMessage({ message }),
 * })
 *
 * const view = (model: Model, h: NativeBuilder<Message>) =>
 *   h('view', null,
 *     h.submodel(Counter, model.counter, message => GotCounterMessage({ message })),
 *   )
 * ```
 *
 * Every stateful component in the UI follows this shape, so the answer to "how
 * do I make this reusable" is always the same two declarations.
 */

/** The declaration of a Submodel: its Model, its transitions and its view. */
export interface SubmodelConfig<Model, Message extends { _tag: string }, OutMessage, Resources = never> {
  /** The Schema for this Submodel's state. The parent holds a value of this type. */
  readonly Model: Schema.Codec<Model, any, unknown, unknown>
  /** The starting state. Returns Commands if it needs to kick anything off. */
  readonly init: () => Return<Model, Message, Resources>
  /** The child's own transitions. Exhaustive over the child's Messages. */
  readonly update: (model: Model, message: Message) => ReturnWithOutMessage<Model, Message, OutMessage, Resources>
  /**
   * A pure function of the child's Model. The parent renders it; the child never draws.
   *
   * The builder is a full one, `h.submodel` included, so a Submodel may itself
   * contain Submodels. That nesting is what makes a page a tree of modules
   * rather than a tree of components with their own state.
   */
  readonly view: (model: Model, h: NativeViewBuilder<Message>) => VNode
  readonly subscriptions?: Subscriptions<Model, Message, Resources>
  readonly managedResources?: ManagedResources<Model, Message, Resources>
  /** For DevTools and for an error message that names the right module. */
  readonly name?: string
}

/** A declared Submodel, branded so `h.submodel` accepts it and nothing else. */
export type Submodel<Model, Message extends { _tag: string }, OutMessage, Resources = never> =
  SubmodelConfig<Model, Message, OutMessage, Resources> & { readonly __submodel: unique symbol }

/**
 * Declares a Submodel.
 *
 * Identity only - the declaration is checked once, here, and afterwards the
 * runtime never looks inside it again. That is what keeps the parent's render
 * path free of any per-child special case.
 */
export const define = <Model, Message extends { _tag: string }, OutMessage, Resources = never>(
  config: SubmodelConfig<Model, Message, OutMessage, Resources>,
): Submodel<Model, Message, OutMessage, Resources> =>
  Object.assign(config, { __submodel: Symbol('foldkit-native.submodel') }) as Submodel<Model, Message, OutMessage, Resources>

/** Lifts every event handler in a tree through `lift`, which turns a child Message into the parent's. */
const liftTree = <ChildMessage, ParentMessage>(vnode: VNode, lift: (message: ChildMessage) => ParentMessage): VNode => {
  if (vnode.kind !== 'element') return vnode
  const { props, children, ...rest } = vnode as ElementVNode

  let nextProps: Record<string, unknown> | undefined
  for (const key of Object.keys(props)) {
    const value = props[key]
    if (typeof value !== 'function') continue
    nextProps ??= { ...props }
    nextProps[key] = (payload: unknown) => lift((value as (payload: unknown) => ChildMessage)(payload))
  }

  // Children only when something in them moved, so a submodel with no events
  // costs one pass over the root rather than a copy of its whole tree.
  let nextChildren: readonly VNode[] = children
  for (let index = 0; index < children.length; index += 1) {
    const lifted = liftTree(children[index]!, lift)
    if (lifted !== children[index]) {
      const copy = [...nextChildren]
      copy[index] = lifted
      nextChildren = copy
    }
  }

  return {
    ...rest,
    props: nextProps ?? props,
    children: nextChildren,
  } as ElementVNode
}

/** The Submodel half of the native builder. */
export interface SubmodelBuilders<Message> {
  /**
   * Renders a Submodel's view at a slice of the parent's Model.
   *
   * `toParent` lifts the child's Messages into the parent's, which is the same
   * function `Update.foldChild` takes: the two halves must agree, or a tap in
   * the child would produce a Message the parent's `update` does not handle.
   *
   * The child's `view` is a pure function of the slice, so it is re-run on every
   * parent render and diffed like any other subtree. A child that owns its own
   * long-lived work - a socket, a timer, a subscription - declares it in
   * `subscriptions` or `managedResources`, and the parent's runtime starts and
   * tears it down with the Model that needs it.
   */
  submodel: <ChildModel, ChildMessage extends { _tag: string }, ChildOutMessage, ChildResources>(
    submodel: Submodel<ChildModel, ChildMessage, ChildOutMessage, ChildResources>,
    model: ChildModel,
    toParent: (message: ChildMessage) => Message,
  ) => VNode
}

/** The builder a `view` is given: `h`, plus the Submodel half. */
export type NativeViewBuilder<Message> = NativeBuilder<Message> & SubmodelBuilders<Message>

/**
 * Builds the `h` a `view` receives.
 *
 * `h.submodel` renders the child through a builder of the child's own, then
 * lifts the event handlers it produced. Doing it by wrapping rather than by
 * giving the child a different builder means the child's `view` is written once,
 * against its own Message union, and knows nothing about the parent's.
 */
export const createViewBuilder = <Message>(): NativeViewBuilder<Message> => {
  const builder = createBuilder<Message>()
  return Object.assign(builder, {
    submodel: <ChildModel, ChildMessage extends { _tag: string }, ChildOutMessage, ChildResources>(
      submodel: Submodel<ChildModel, ChildMessage, ChildOutMessage, ChildResources>,
      model: ChildModel,
      toParent: (message: ChildMessage) => Message,
    ): VNode => liftTree(submodel.view(model, createViewBuilder<ChildMessage>()), toParent),
  }) as NativeViewBuilder<Message>
}