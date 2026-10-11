import { Option } from 'effect'
import type { Command } from './command.js'
import { mapMessages } from './command.js'

/**
 * What `update` returns.
 *
 * This module is types first. `update` is the one function in an application
 * that decides what a fact means, so its return type is where the architecture
 * is actually enforced: a next Model, a list of Commands, and - for a Submodel
 * reporting to a parent - at most one OutMessage. Nothing else. There is no way
 * to perform a side effect here, because there is nowhere in this type to put
 * one.
 */

/** The Commands an update return may include. `R` is the services they need. */
export type Commands<Message, R = never> = ReadonlyArray<Command<Message, never, R>>

/**
 * The record an update returns.
 *
 * Inline the type where a matcher is its only use, or give it an alias when
 * another matcher or helper in the module needs the same one:
 *
 * ```ts
 * type UpdateReturn = Update.Return<Model, Message>
 *
 * const update = (model: Model, message: Message) =>
 *   Message.match<UpdateReturn>(message, {
 *     ClickedIncrement: () => ({ model: modifyFields(model, { count: count => count + 1 }) }),
 *     ChangedResetDuration: ({ seconds }) => ({
 *       model: modifyFields(model, { resetDuration: () => seconds }),
 *     }),
 *     ClickedResetAfterDelay: () => ({
 *       model: modifyFields(model, { isResetting: () => true }),
 *       commands: [DelayReset({ seconds: model.resetDuration })],
 *     }),
 *     CompletedDelayReset: () => ({
 *       model: modifyFields(model, { count: () => 0, isResetting: () => false }),
 *     }),
 *   })
 * ```
 *
 * `outMessage?: never` is deliberate: it lets an update that cannot report to a
 * parent write the natural return, while rejecting one that emits an OutMessage
 * where the caller keeps only the Model and Commands.
 */
export type Return<Model, Message, R = never> = Readonly<{
  model: Model
  commands?: Commands<Message, R>
  outMessage?: never
}>

/** The same record, for an update that may also surface an OutMessage to its parent. */
export type ReturnWithOutMessage<Model, Message, OutMessage, R = never> = Readonly<{
  model: Model
  commands?: Commands<Message, R>
  outMessage?: OutMessage
}>

/** One self-contained edit to the Model with the Commands it causes. */
export type Step<Model, Message, R = never> = (model: Model) => Return<Model, Message, R>

/** A Step that may also report an OutMessage. */
export type StepWithOutMessage<Model, Message, OutMessage, R = never> = (
  model: Model,
) => ReturnWithOutMessage<Model, Message, OutMessage, R>

/**
 * Attaches an OutMessage to a plain update return, keeping its Model and
 * Commands. Use it when the OutMessage is computed after the fact and may be
 * `undefined`, which means "this step emitted nothing" - the property is then
 * omitted rather than set.
 *
 * ```ts
 * const clearDraft = Update.combine(model, [writeDraft, clearErrors])
 * return pipe(clearDraft, Update.withOutMessage(outMessage))
 * ```
 *
 * When the OutMessage is already known, include it directly:
 * `{ model, commands, outMessage }`.
 */
export const withOutMessage: {
  <OutMessage>(outMessage: OutMessage | undefined): <Model, Message, R = never>(
    updateReturn: Return<Model, Message, R>,
  ) => ReturnWithOutMessage<Model, Message, OutMessage, R>
  <Model, Message, OutMessage, R = never>(
    updateReturn: Return<Model, Message, R>,
    outMessage: OutMessage | undefined,
  ): ReturnWithOutMessage<Model, Message, OutMessage, R>
} = Object.assign(
  <OutMessage>(outMessage: OutMessage | undefined) =>
    <Model, Message, R = never>(
      updateReturn: Return<Model, Message, R>,
    ): ReturnWithOutMessage<Model, Message, OutMessage, R> =>
      outMessage === undefined
        ? (updateReturn as ReturnWithOutMessage<Model, Message, OutMessage, R>)
        : ({ ...updateReturn, outMessage } as ReturnWithOutMessage<Model, Message, OutMessage, R>),
  <Model, Message, OutMessage, R = never>(
    updateReturn: Return<Model, Message, R>,
    outMessage: OutMessage | undefined,
  ): ReturnWithOutMessage<Model, Message, OutMessage, R> =>
    outMessage === undefined
      ? (updateReturn as ReturnWithOutMessage<Model, Message, OutMessage, R>)
      : ({ ...updateReturn, outMessage } as ReturnWithOutMessage<Model, Message, OutMessage, R>),
) as any

/**
 * Runs steps in order, threading the Model through and concatenating the
 * Commands they produce.
 *
 * One handler often answers a fact with several independent edits - write the
 * note and clear the errors. `combine` keeps that as one `match` arm instead of
 * a hand-rolled fold over the intermediate Models:
 *
 * ```ts
 * ClickedSave: () => Update.combine(model, [writeDraft, clearErrors]),
 * ```
 *
 * The steps run in the order written, so a later step sees what an earlier one
 * changed. The Commands come back in that order too; the runtime then runs them
 * concurrently, as `Update` says it does.
 */
export function combine<Model, Message, R = never>(
  model: Model,
  steps: ReadonlyArray<Step<Model, Message, R>>,
): Return<Model, Message, R> {
  let next = model
  const commands: Array<Command<Message, never, R>> = []
  for (const step of steps) {
    const result = step(next)
    next = result.model
    if (result.commands) commands.push(...result.commands)
  }
  return commands.length === 0 ? { model: next } : { model: next, commands }
}

/**
 * The lifters a fold is given for Commands a step returns that still produce the
 * child's Message. Already bound to the fold's `toParentMessage`.
 */
export type FoldContext<ChildMessage, ParentMessage> = Readonly<{
  toParentMessage: (message: ChildMessage) => ParentMessage
  mapMessage: (message: ChildMessage) => Return<ChildMessage, ChildMessage>
}>

/** What `foldChild` needs to embed a child's `update` in a parent's. */
export type ChildFold<ParentModel, ParentMessage, ChildModel, Input, ChildMessage, R = never> = Readonly<{
  update: (childModel: ChildModel, input: Input) => Return<ChildModel, ChildMessage, R>
  read: (model: ParentModel) => Option.Option<ChildModel>
  write: (model: ParentModel, nextChildModel: ChildModel) => ParentModel
  toParentMessage: (message: ChildMessage) => ParentMessage
}>

/** {@link ChildFold} for a child whose update returns OutMessages as well. */
export type ChildFoldWithOutMessage<
  ParentModel,
  ParentMessage,
  ChildModel,
  Input,
  ChildMessage,
  ChildOutMessage,
  ChildRequirements = never,
  OutMessageStepRequirements = ChildRequirements,
  OutMessageStepMessage = ParentMessage,
> = Readonly<{
  update: (childModel: ChildModel, input: Input) => ReturnWithOutMessage<ChildModel, ChildMessage, ChildOutMessage, ChildRequirements>
  read: (model: ParentModel) => Option.Option<ChildModel>
  write: (model: ParentModel, nextChildModel: ChildModel) => ParentModel
  toParentMessage: (message: ChildMessage) => ParentMessage
  foldOutMessage: (
    outMessage: ChildOutMessage,
    context: FoldContext<ChildMessage, ParentMessage>,
  ) => Step<NoInfer<ParentModel>, OutMessageStepMessage, OutMessageStepRequirements>
}>

/**
 * The fold: a dual function, so it slots into either calling style.
 *
 * `fold(model, input)` applies one fact now. `fold(input)` builds a Step for
 * `Update.combine`.
 */
export type Fold<ParentModel, ParentMessage, Input, R = never> = {
  (model: ParentModel, input: Input): Return<ParentModel, ParentMessage, R>
  (input: Input): Step<ParentModel, ParentMessage, R>
}

/** {@link Fold} for a child that can report an OutMessage, for a parent that is not a Submodel itself. */
export type FoldAt<ParentModel, ParentMessage, Input, R = never> = {
  (model: ParentModel, input: Input): Return<ParentModel, ParentMessage, R>
  (input: Input): Step<ParentModel, ParentMessage, R>
}

/** {@link Fold} for a parent that is itself a Submodel, so the fold can return the parent's OutMessage. */
export type FoldWithOutMessage<ParentModel, ParentMessage, Input, ParentOutMessage, R = never> = {
  (model: ParentModel, input: Input): ReturnWithOutMessage<ParentModel, ParentMessage, ParentOutMessage, R>
  (input: Input): StepWithOutMessage<ParentModel, ParentMessage, ParentOutMessage, R>
}

type AnyReturn = Readonly<{ model: any; commands?: ReadonlyArray<Command<any, any, any>>; outMessage?: any }>

/**
 * Folds a child Submodel's `update` into the parent: the update half of
 * embedding a child, complementing `h.submodel` on the view half.
 *
 * A child is not a special case in the parent's Model - it is a slice of it.
 * The fold reads that slice, runs the child's own `update` against it, writes
 * the result back, and lifts the child's Commands into the parent's Messages.
 * So the child's transitions stay in the child's module and the parent's
 * `update` stays a list of facts, rather than growing a branch per child.
 *
 * ```ts
 * const foldSearch = Update.foldChild({
 *   update: Search.update,
 *   read: (model: Model) => Option.some(model.search),
 *   write: (model, nextSearch) => modifyFields(model, { search: () => nextSearch }),
 *   toParentMessage: message => GotSearchMessage({ message }),
 * })
 *
 * const update = (model: Model, message: Message) =>
 *   Message.match<Update.Return<Model, Message>>(message, {
 *     ChangedSearchQuery: ({ query }) => foldSearch(model, { query }),
 *     GotSearchMessage: ({ message }) => foldSearch(model, message),
 *   })
 * ```
 *
 * A child that is absent from the Model is skipped: the fold returns the Model
 * unchanged, which is what makes an optional child safe to leave out of a
 * screen.
 */
export function foldChild<ParentModel, ParentMessage, ChildModel, Input, ChildMessage, R = never>(
  config: ChildFold<ParentModel, ParentMessage, ChildModel, Input, ChildMessage, R>,
): Fold<ParentModel, ParentMessage, Input, R>
export function foldChild<
  ParentModel,
  ParentMessage,
  ChildModel,
  Input,
  ChildMessage,
  ChildOutMessage,
  ChildRequirements = never,
  OutMessageStepRequirements = ChildRequirements,
>(config: ChildFoldWithOutMessage<ParentModel, ParentMessage, ChildModel, Input, ChildMessage, ChildOutMessage, ChildRequirements, OutMessageStepRequirements>): FoldAt<
  ParentModel,
  ParentMessage,
  Input,
  ChildRequirements | OutMessageStepRequirements
>
export function foldChild(config: any): any {
  const { update, read, write, toParentMessage, foldOutMessage } = config as any

  const fold = (input: any) => (model: any): AnyReturn => {
    const child = read(model)
    if (Option.isNone(child)) return { model }

    const result: AnyReturn = update(child.value, input)
    const nextModel = write(model, result.model)

    // The child's Commands produce the child's Messages, which the parent has
    // to receive as its own. Lifting here is what keeps the child from knowing
    // anything about the parent's Message union.
    const lifted: Array<Command<any, never, never>> = [
      ...mapMessages(result.commands, toParentMessage) as Array<Command<any, never, never>>,
    ]

    if (foldOutMessage && result.outMessage !== undefined) {
      const context: FoldContext<any, any> = {
        toParentMessage,
        mapMessage: (message: any) => ({ model: child.value, commands: [] }) as any,
      }
      const step = foldOutMessage(result.outMessage, context)
      const stepResult: AnyReturn = step(nextModel)
      lifted.push(...mapMessages(stepResult.commands, toParentMessage) as Array<Command<any, never, never>>)
      if (stepResult.outMessage === undefined) {
        return {
          model: stepResult.model,
          ...(lifted.length === 0 ? {} : { commands: lifted }),
        }
      }
      return {
        model: stepResult.model,
        ...(lifted.length === 0 ? {} : { commands: lifted }),
        outMessage: stepResult.outMessage,
      }
    }

    return { model: nextModel, ...(lifted.length === 0 ? {} : { commands: lifted }) }
  }

  // Dual, by arity: `fold(model, input)` applies one fact now, `fold(input)`
  // builds a Step for `Update.combine`. A two-argument call is unambiguous, and
  // an input that is itself an array does not confuse it, which a shape test
  // would have to guess about.
  function dual(first: any, second?: any): any {
    return arguments.length >= 2 ? fold(second)(first) : fold(first)
  }
  Object.assign(dual, { __step: fold })
  return dual
}

