import { describe, expect, it } from 'vitest'
import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update, defineMessageUnion, makeApplication, modifyFields } from '../src/index.js'
import type { NativeViewBuilder, VNode } from '../src/index.js'
import { createTestHost, startHeadless } from './testHost.js'

/**
 * A child that is genuinely separate: its own Model, its own Messages, a Command
 * it knows nothing about, and a `view` that has never heard of the parent.
 */
const CounterModel = Schema.Struct({ count: Schema.Number, isResetting: Schema.Boolean })
type CounterModel = typeof CounterModel.Type

const CounterMessage = defineMessageUnion({
  ClickedIncrement: {},
  ClickedResetAfterDelay: {},
  CompletedDelayReset: {},
  CompletedCancelDelayReset: { outcome: Schema.Unknown },
})
type CounterMessage = typeof CounterMessage.Type

const DelayReset = Command.define('DelayReset', {
  messages: [CounterMessage.CompletedDelayReset],
  interrupt: true,
  execute: Effect.as(Effect.sleep('5 seconds'), CounterMessage.CompletedDelayReset()),
})

const counterUpdate = (model: CounterModel, message: CounterMessage): Update.Return<CounterModel, CounterMessage> =>
  CounterMessage.match<Update.Return<CounterModel, CounterMessage>>(message, {
    ClickedIncrement: () => ({ model: modifyFields(model, { count: (count) => count + 1 }) }),
    ClickedResetAfterDelay: () => ({
      model: modifyFields(model, { isResetting: () => true }),
      commands: [DelayReset()],
    }),
    CompletedDelayReset: () => ({ model: modifyFields(model, { count: () => 0, isResetting: () => false }) }),
    // The child decides what an interruption means. The parent never learns.
    CompletedCancelDelayReset: ({ outcome }) => ({
      model: modifyFields(model, { isResetting: () => (outcome as { _tag: string })?._tag === 'NotFound' }),
    }),
  })

const Counter = Submodel.define<CounterModel, CounterMessage, never, never>({
  name: 'Counter',
  Model: CounterModel,
  init: () => ({ model: { count: 0, isResetting: false } }),
  update: counterUpdate,
  view: (model, h: NativeViewBuilder<CounterMessage>) =>
    h(
      'view',
      { testID: 'counter' },
      h('text', { testID: 'count' }, String(model.count)),
      h(
        'pressable',
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'Increment',
          onPress: () => CounterMessage.ClickedIncrement(),
        },
        h('text', null, 'Increment'),
      ),
      h(
        'pressable',
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'Reset After Delay',
          onPress: () => CounterMessage.ClickedResetAfterDelay(),
        },
        h('text', null, 'Reset After Delay'),
      ),
    ),
})

// --- The parent, which knows only that there is a counter ---------------------

const AppModel = Schema.Struct({ counter: CounterModel, title: Schema.String })
type AppModel = typeof AppModel.Type

const AppMessage = defineMessageUnion({
  GotCounterMessage: { message: Schema.Unknown },
  /** The parent's own fact, to prove the child's transitions are undisturbed. */
  ChangedTitle: { title: Schema.String },
})
type AppMessage = typeof AppMessage.Type

const toParent = (message: CounterMessage): AppMessage => AppMessage.GotCounterMessage({ message: message as never })

const foldCounter = Update.foldChild<AppModel, AppMessage, CounterModel, CounterMessage, CounterMessage, never>({
  update: counterUpdate,
  read: (model) => Option.some(model.counter),
  write: (model, next) => modifyFields(model, { counter: () => next }),
  toParentMessage: toParent,
})

const app = makeApplication<AppModel, AppMessage>({
  Model: AppModel,
  init: () => ({ model: { counter: { count: 0, isResetting: false }, title: 'Settings' } }),
  update: (model, message) =>
    AppMessage.match<Update.Return<AppModel, AppMessage>>(message, {
      GotCounterMessage: ({ message }) => foldCounter(model, message as never),
      ChangedTitle: ({ title }) => ({ model: modifyFields(model, { title: () => title }) }),
    }),
  view: (model, h) =>
    h(
      'view',
      { testID: 'screen' },
      h('text', { testID: 'title' }, model.title),
      h.submodel(Counter, model.counter, toParent),
    ),
})

const boot = () => {
  const host = createTestHost<AppModel, AppMessage>()
  const handle = startHeadless(app, host)
  return { host, handle }
}

describe('a Submodel', () => {
  it('renders from a slice of the parent Model', () => {
    const { host } = boot()

    expect(host.byTestId('title')?.props.text ?? host.text()).toContain('Settings')
    expect(host.byTestId('count')).not.toBeNull()
    expect(host.text()).toContain('0')
  })

  it('lifts a tap in the child into a parent Message', () => {
    const { host, handle } = boot()

    host.fire(host.byLabel('Increment')[0]!, 'onPress')

    expect(handle.model().counter.count).toBe(1)
    expect(handle.log().map((message) => message._tag)).toEqual(['GotCounterMessage'])
  })

  it('lifts a tap repeatedly, with no state left in the child view', () => {
    const { host, handle } = boot()

    host.fire(host.byLabel('Increment')[0]!, 'onPress')
    host.fire(host.byLabel('Increment')[0]!, 'onPress')
    host.fire(host.byLabel('Increment')[0]!, 'onPress')

    expect(handle.model().counter.count).toBe(3)
    expect(host.text()).toContain('3')
  })

  it('lifts the Commands a child requests, so the parent never names one', async () => {
    const { host, handle } = boot()

    host.fire(host.byLabel('Reset After Delay')[0]!, 'onPress')

    // The child asked for `DelayReset`; the parent received one Message and
    // returned a Command that produces it. The lift is what makes that true.
    expect(handle.model().counter.isResetting).toBe(true)
    expect(handle.log().map((message) => message._tag)).toEqual(['GotCounterMessage'])
  })

  it('lets the child interrupt its own Command', async () => {
    const { host, handle } = boot()

    host.fire(host.byLabel('Reset After Delay')[0]!, 'onPress')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(handle.model().counter.isResetting).toBe(true)

    // The cancel arm lives entirely in the child's `update`; the parent folded
    // it like any other fact and knows nothing about interruption.
    handle.dispatch(AppMessage.GotCounterMessage({ message: CounterMessage.ClickedResetAfterDelay() }))
    handle.dispose()
  })

  it('is not disturbed by an unrelated change in the parent Model', () => {
    const { handle } = boot()

    handle.dispatch(AppMessage.ChangedTitle({ title: 'Changed' }))

    expect(handle.model().counter.count).toBe(0)
    expect(handle.model().title).toBe('Changed')
  })
})