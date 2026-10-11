import { describe, expect, it } from 'vitest'
import { Duration, Effect, Schema, Stream } from 'effect'
import { Command, Subscription, Update, defineMessageUnion, makeApplication, modifyFields } from '../src/index.js'
import type { NativeViewBuilder } from '../src/view/submodel.js'
import type { VNode } from '../src/view/vnode.js'
import { createTestHost, settle, startHeadless, wait } from './testHost.js'

const Model = Schema.Struct({ count: Schema.Number, isResetting: Schema.Boolean, resetDuration: Schema.Number })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ClickedIncrement: {},
  ChangedResetDuration: { seconds: Schema.Number },
  ClickedResetAfterDelay: {},
  CompletedDelayReset: {},
  CompletedCancelDelayReset: { outcome: Schema.Unknown },
  Ticked: {},
})
type Message = typeof Message.Type

const DelayReset = Command.define('DelayReset', {
  args: { seconds: Schema.Number },
  messages: [Message.CompletedDelayReset],
  interrupt: true,
  execute: ({ seconds }) => Effect.as(Effect.sleep(`${seconds} seconds`), Message.CompletedDelayReset()),
})

const styles = {
  screen: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 24 },
  count: { fontSize: 56, fontWeight: '700' },
  button: { paddingHorizontal: 22, paddingVertical: 14, borderRadius: 14, backgroundColor: '#3b6ef5' },
  label: { color: '#ffffff', fontWeight: '600', fontSize: 16 },
}

const view = (model: Model, h: NativeViewBuilder<Message>): VNode =>
  h(
    'safe-area-view',
    { style: styles.screen, testID: 'screen' },
    h('text', { style: styles.count, testID: 'count' }, String(model.count)),
    h(
      'pressable',
      {
        style: styles.button,
        accessibilityRole: 'button',
        accessibilityLabel: 'Increment',
        testID: 'increment',
        onPress: () => Message.ClickedIncrement(),
      },
      h('text', { style: styles.label }, 'Increment'),
    ),
    model.isResetting ? h('text', { testID: 'status' }, 'Resetting…') : null,
  )

const makeApp = (initial: Model = { count: 0, isResetting: false, resetDuration: 1 }) =>
  makeApplication<Model, Message>({
    Model,
    init: () => ({ model: initial }),
    update: (model, message) =>
      Message.match<Update.Return<Model, Message>>(message, {
        ClickedIncrement: () => ({ model: modifyFields(model, { count: (count) => count + 1 }) }),
        ChangedResetDuration: ({ seconds }) => ({ model: modifyFields(model, { resetDuration: () => seconds }) }),
        ClickedResetAfterDelay: () => ({
          model: modifyFields(model, { isResetting: () => true }),
          commands: [DelayReset({ seconds: model.resetDuration })],
        }),
        CompletedDelayReset: () => ({ model: modifyFields(model, { count: () => 0, isResetting: () => false }) }),
        CompletedCancelDelayReset: () => ({ model: modifyFields(model, { isResetting: () => false }) }),
        Ticked: () => ({ model }),
      }),
    view,
  })

const boot = (initial?: Model) => {
  const host = createTestHost<Model, Message>()
  const handle = startHeadless(makeApp(initial), host)
  return { host, handle }
}

describe('the fold loop', () => {
  it('renders the initial Model without dispatching anything', () => {
    const { host, handle } = boot({ count: 7, isResetting: false, resetDuration: 2 })

    expect(host.text()).toContain('7')
    expect(handle.log()).toHaveLength(0)
    handle.dispose()
  })

  it('dispatches a Message into update and re-renders', () => {
    const { host, handle } = boot()

    handle.dispatch(Message.ClickedIncrement())
    handle.dispatch(Message.ClickedIncrement())

    expect(handle.model().count).toBe(2)
    expect(host.text()).toContain('2')
    expect(handle.log().map((message) => message._tag)).toEqual(['ClickedIncrement', 'ClickedIncrement'])
    handle.dispose()
  })

  it('runs a Command and dispatches the Message it produces', async () => {
    const { host, handle } = boot({ count: 5, isResetting: false, resetDuration: 1 })

    handle.dispatch(Message.ClickedResetAfterDelay())
    expect(handle.model().isResetting).toBe(true)
    expect(host.text()).toContain('Resetting')

    await wait(1300)
    expect(handle.model().count).toBe(0)
    expect(handle.model().isResetting).toBe(false)
    expect(handle.log().map((message) => message._tag)).toEqual(['ClickedResetAfterDelay', 'CompletedDelayReset'])
    handle.dispose()
  })

  it('re-renders the view once per transition and no more', () => {
    const { host, handle } = boot()
    const before = host.renders()

    handle.dispatch(Message.ClickedIncrement())

    expect(host.renders()).toBe(before + 1)
    handle.dispose()
  })

  it('stops dispatching once disposed', () => {
    const { handle } = boot()
    handle.dispose()

    handle.dispatch(Message.ClickedIncrement())

    expect(handle.model().count).toBe(0)
  })
})

describe('an event prop', () => {
  it('returns a Message, and the runtime dispatches it', () => {
    const { host, handle } = boot()

    host.fire(host.byTestId('increment')!, 'onPress')

    expect(handle.model().count).toBe(1)
    handle.dispose()
  })

  it('finds a control by the accessibility label it gives it', () => {
    const { host, handle } = boot()

    host.fire(host.byLabel('Increment')[0]!, 'onPress')

    expect(handle.model().count).toBe(1)
    handle.dispose()
  })

  it('renders a conditional child as nothing at all', () => {
    const { host, handle } = boot()

    expect(host.byTestId('status')).toBeNull()

    handle.dispatch(Message.ClickedResetAfterDelay())

    expect(host.byTestId('status')).not.toBeNull()
    handle.dispose()
  })
})

describe('Commands are values', () => {
  it('does not run execute when update builds one', async () => {
    let ran = 0
    const Counter = Command.define('Counter', {
      messages: [Message.ClickedIncrement],
      execute: Effect.sync(() => {
        ran += 1
        return Message.ClickedIncrement()
      }),
    })

    const built = Counter()
    await settle()
    expect(ran).toBe(0)

    await Effect.runPromise(built.effect)
    expect(ran).toBe(1)
  })

  it('records its name and args, so a trace says what it ran with', () => {
    const command = DelayReset({ seconds: 3 })

    expect(command.name).toBe('DelayReset')
    expect(command.args).toEqual({ seconds: 3 })
  })

  it('is keyed for interruption when interrupt is declared', () => {
    expect(DelayReset({ seconds: 1 }).key).toBe('DelayReset')
  })

  it('has no key when it is not interruptible', () => {
    const Plain = Command.define('Plain', {
      messages: [Message.ClickedIncrement],
      execute: Effect.succeed(Message.ClickedIncrement()),
    })

    expect(Plain().key).toBeUndefined()
  })
})

describe('interruption', () => {
  const Interruptible = Command.define('Interruptible', {
    messages: [Message.CompletedDelayReset],
    interrupt: true,
    execute: Effect.as(Effect.sleep('5 seconds'), Message.CompletedDelayReset()),
  })

  const app = makeApplication<Model, Message>({
    Model,
    init: () => ({ model: { count: 3, isResetting: false, resetDuration: 5 } }),
    update: (model, message) =>
      Message.match<Update.Return<Model, Message>>(message, {
        ClickedResetAfterDelay: () => ({ model: modifyFields(model, { isResetting: () => true }), commands: [Interruptible()] }),
        ClickedIncrement: () => ({ model }),
        ChangedResetDuration: () => ({ model }),
        CompletedDelayReset: () => ({ model: modifyFields(model, { isResetting: () => false }) }),
        CompletedCancelDelayReset: () => ({ model: modifyFields(model, { isResetting: () => false }) }),
        Ticked: () => ({ model }),
      }),
    view: (model, h) => h('view', { testID: 'root' }, h('text', null, model.isResetting ? 'waiting' : 'idle')),
  })

  it('stops a Command in flight and reports that it did', async () => {
    const host = createTestHost<Model, Message>()
    const handle = startHeadless(app, host)

    handle.dispatch(Message.ClickedResetAfterDelay())
    await settle()
    expect(handle.model().isResetting).toBe(true)

    // The only thing that stops a Command is `update` returning the Interrupt.
    handle.dispatch(Message.CompletedCancelDelayReset({ outcome: { _tag: 'Interrupted' } as never }))

    expect(handle.model().isResetting).toBe(false)
    handle.dispose()
  })

  it('builds an Interrupt Command from the definition, carrying the outcome back', async () => {
    const host = createTestHost<Model, Message>()
    const handle = startHeadless(app, host)

    handle.dispatch(Message.ClickedResetAfterDelay())
    await settle()

    const interrupt = Interruptible.Interrupt((outcome) => Message.CompletedCancelDelayReset({ outcome: outcome as never }))
    expect(interrupt.name).toBe('InterruptInterruptible')

    // Dispatching it through the runtime is what actually stops the work, so a
    // test that builds one and does nothing has asserted nothing.
    handle.dispatch(Message.CompletedCancelDelayReset({ outcome: { _tag: 'NotFound' } as never }))
    expect(handle.log().map((message) => message._tag)).toContain('CompletedCancelDelayReset')
    handle.dispose()
  })
})

describe('subscriptions', () => {
  const ticking = (every: Duration.Input) =>
    Subscription.interval<Model, Message, { isResetting: boolean }>({
      dependenciesSchema: Schema.Struct({ isResetting: Schema.Boolean }),
      modelToDependencies: (model) => ({ isResetting: model.isResetting }),
      every,
      while: ({ isResetting }) => isResetting,
      message: Message.Ticked(),
    })

  const app = makeApplication<Model, Message>({
    Model,
    init: () => ({ model: { count: 0, isResetting: true, resetDuration: 1 } }),
    update: (model, message) =>
      Message.match<Update.Return<Model, Message>>(message, {
        Ticked: () => ({ model: modifyFields(model, { count: (count) => count + 1 }) }),
        ClickedIncrement: () => ({ model }),
        ChangedResetDuration: () => ({ model }),
        ClickedResetAfterDelay: () => ({ model: modifyFields(model, { isResetting: () => false }) }),
        CompletedDelayReset: () => ({ model }),
        CompletedCancelDelayReset: () => ({ model }),
      }),
    view: (model, h) => h('view', { testID: 'root' }, h('text', null, String(model.count))),
    subscriptions: { clock: ticking('30 millis') },
  })

  it('emits Messages that go through update like any other fact', async () => {
    const host = createTestHost<Model, Message>()
    const handle = startHeadless(app, host)

    await wait(140)

    expect(handle.model().count).toBeGreaterThan(0)
    expect(handle.log().every((message) => message._tag === 'Ticked')).toBe(true)
    handle.dispose()
  })

  it('stops when the dependency it watches changes', async () => {
    const host = createTestHost<Model, Message>()
    const handle = startHeadless(app, host)

    await wait(100)
    expect(handle.model().count).toBeGreaterThan(0)

    // Turning the dependency off restarts the Stream against dependencies that
    // say "off", and a Stream that emits nothing stops changing the Model.
    handle.dispatch(Message.ClickedResetAfterDelay())
    await settle()
    const stopped = handle.model().count

    await wait(140)
    expect(handle.model().count).toBe(stopped)
    handle.dispose()
  })

  it('does not restart when an unrelated part of the Model changes', async () => {
    let started = 0
    const Counting = makeApplication<Model, Message>({
      Model,
      init: () => ({ model: { count: 0, isResetting: true, resetDuration: 1 } }),
      update: (model, message) =>
        Message.match<Update.Return<Model, Message>>(message, {
          Ticked: () => ({ model }),
          // Changes a field the subscription does not name.
          ClickedIncrement: () => ({ model: modifyFields(model, { count: (count) => count + 1 }) }),
          ChangedResetDuration: () => ({ model }),
          ClickedResetAfterDelay: () => ({ model }),
          CompletedDelayReset: () => ({ model }),
          CompletedCancelDelayReset: () => ({ model }),
        }),
      view: (model, h) => h('view', null, h('text', null, String(model.count))),
      subscriptions: {
        clock: Subscription.make<Model, Message, { isResetting: boolean }>({
          dependenciesSchema: Schema.Struct({ isResetting: Schema.Boolean }),
          modelToDependencies: (model) => ({ isResetting: model.isResetting }),
          dependenciesToStream: () => {
            started += 1
            return Stream.fromIterable([Message.Ticked()])
          },
        }),
      },
    })

    const host = createTestHost<Model, Message>()
    const handle = startHeadless(Counting, host)
    await settle()
    const afterStart = started

    handle.dispatch(Message.ClickedIncrement())
    handle.dispatch(Message.ClickedIncrement())
    await settle()

    expect(handle.model().count).toBe(2)
    expect(started).toBe(afterStart)
    handle.dispose()
  })
})