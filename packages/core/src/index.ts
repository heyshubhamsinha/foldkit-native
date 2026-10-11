/**
 * Foldkit Native.
 *
 * The Foldkit architecture - one immutable Model defined by Schema, Messages
 * named for facts, an exhaustive pure `update`, and side effects as Commands it
 * returns - rendering to real native iOS and Android views.
 *
 * A `view` here does not produce HTML. It produces a tree of native elements
 * that the engine commits to Fabric, so a `<view>` is a `UIView` on iOS and an
 * `android.view.View` on Android, and a `<text>` is a `Paragraph` and a
 * `TextView`. Nothing in between is a web view.
 *
 * ```ts
 * import { Effect, Schema } from 'effect'
 * import { Command } from 'foldkit-native/command'
 * import { Update } from 'foldkit-native/update'
 * import { defineMessageUnion } from 'foldkit-native/message'
 * import { modifyFields } from 'foldkit-native/struct'
 *
 * const Model = Schema.Struct({ count: Schema.Number })
 * type Model = typeof Model.Type
 *
 * const Message = defineMessageUnion({
 *   ClickedIncrement: {},
 *   CompletedDelayReset: {},
 * })
 * type Message = typeof Message.Type
 *
 * const DelayReset = Command.define('DelayReset', {
 *   args: { seconds: Schema.Number },
 *   messages: [Message.CompletedDelayReset],
 *   execute: ({ seconds }) =>
 *     Effect.as(Effect.sleep(`${seconds} seconds`), Message.CompletedDelayReset()),
 * })
 *
 * type UpdateReturn = Update.Return<Model, Message>
 * const update = (model: Model, message: Message) =>
 *   Message.match<UpdateReturn>(message, {
 *     ClickedIncrement: () => ({ model: modifyFields(model, { count: count => count + 1 }) }),
 *     CompletedDelayReset: () => ({ model: modifyFields(model, { count: () => 0 }) }),
 *   })
 * ```
 *
 * The Messages, `update` and Commands in that snippet are exactly Foldkit's. What
 * changes is the view, and that is the whole claim of this package: the
 * architecture is not a web framework's, it is Elm's, and Elm never had a DOM.
 */

export { defineMessageUnion, defineTaggedUnion, taggedStruct, ReservedTagError } from './schema.js'
export type { CallableTaggedStruct, TaggedUnion, TaggedUnionType, Variant } from './schema.js'

export { modifyFields, makeModifyFieldsFor } from './struct.js'
export type { EvolveTransform } from './struct.js'

/** The namespaced surface, so `Command.define` and `Update.Return` each read as one call. */
export * as Command from './command.js'
export * as Message from './message.js'
export * as Update from './update.js'
export * as Struct from './struct.js'
export * as Submodel from './view/submodel.js'
export * as Subscription from './runtime/subscriptions.js'
export * as ManagedResource from './runtime/managedResource.js'
export * as Dispatch from './runtime/dispatch.js'
export * as Runtime from './runtime/runtime.js'
export * as Story from './test/story.js'
export * as Scene from './test/scene.js'

export { define as defineCommand, mapEffect, mapMessage, mapMessages, InterruptOutcome, interruptRequestOf } from './command.js'
export type {
  Command as CommandValue,
  CommandDefinition,
  CommandDefinitionNoArgs,
  CommandDefinitionWithArgs,
  InterruptOption,
  InterruptRequest,
} from './command.js'

export { combine, foldChild, withOutMessage } from './update.js'
export type {
  ChildFold,
  ChildFoldWithOutMessage,
  Commands,
  Fold,
  FoldAt,
  FoldContext,
  Return,
  ReturnWithOutMessage,
  Step,
  StepWithOutMessage,
} from './update.js'

export { createBuilder, fragment, h, text } from './view/builder.js'
export { createViewBuilder } from './view/submodel.js'
export * as View from './view/vnode.js'
export type {
  CommonProps,
  EventPayload,
  LayoutEvent,
  NativeBuilder,
  NativeElementName,
  NativeEventProps,
  NativeProps,
  PressEvent,
  ScrollEvent,
  SelectionEvent,
  SizeEvent,
  Style,
  StyleValue,
} from './view/elements.js'
export type { ElementVNode, FragmentVNode, TextVNode, VNode, VNodeChild } from './view/vnode.js'
export type { NativeViewBuilder } from './view/submodel.js'

export { makeApplication, run } from './runtime/runtime.js'
export type { ApplicationConfig, Program, RuntimeHandle, RuntimeHost } from './runtime/runtime.js'

export { createRenderer } from './renderer/fabricRenderer.js'
export type { Renderer, RendererOptions } from './renderer/fabricRenderer.js'

export { mountNative, makeNativeHost, mountNativeProgram } from './platform.js'
export type { NativeHostOptions, NativeSurface } from './platform.js'

export { Effect } from 'effect'