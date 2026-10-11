/**
 * The Counter Submodel.
 *
 * This module is the whole feature: a count, a delay, a reset, and the four
 * Messages that can happen to it. It knows nothing about the screen it will be
 * drawn on, and the screen knows nothing about it beyond the fact that this
 * Submodel exists.
 *
 * That is the point of a Submodel. The counter resets after a delay that the
 * user can change, and it can be cancelled halfway - which is four Messages, a
 * Command, and an interruption. Embedding it in two screens should not make
 * either screen know any of that, and with `Submodel.define` plus
 * `Update.foldChild` it does not: the parent gains one field on its Model and
 * one Message that says "something happened in the counter".
 */

import { Effect, Schema } from 'effect'
import { Command, Submodel, Update, defineMessageUnion, modifyFields } from '@foldkit-native/core'
import type { NativeViewBuilder, VNode } from '@foldkit-native/core'

export const CounterModel = Schema.Struct({
  count: Schema.Number,
  isResetting: Schema.Boolean,
  resetDuration: Schema.Number,
})
export type CounterModel = typeof CounterModel.Type

export const CounterMessage = defineMessageUnion({
  ClickedIncrement: {},
  ChangedResetDuration: { seconds: Schema.Number },
  ClickedResetAfterDelay: {},
  CompletedDelayReset: {},
  /** The user asked to stop the pending reset. */
  ClickedCancelDelayReset: {},
  /** The outcome of the interruption: did anything actually stop? */
  CompletedCancelDelayReset: { outcome: Schema.Unknown },
})
export type CounterMessage = typeof CounterMessage.Type

/**
 * Waits, then reports that it finished.
 *
 * `interrupt: true` keys every invocation by the Command's name, which is what
 * makes the reset cancellable: only one reset is ever meaningfully in flight, so
 * a second `Reset After Delay` is addressable without knowing which request it
 * belongs to.
 */
export const DelayReset = Command.define('DelayReset', {
  args: { seconds: Schema.Number },
  messages: [CounterMessage.CompletedDelayReset],
  interrupt: true,
  execute: ({ seconds }) => Effect.as(Effect.sleep(`${seconds} seconds`), CounterMessage.CompletedDelayReset()),
})

export type UpdateReturn = Update.Return<CounterModel, CounterMessage>

export const update = (model: CounterModel, message: CounterMessage): UpdateReturn =>
  CounterMessage.match<UpdateReturn>(message, {
    ClickedIncrement: () => ({ model: modifyFields(model, { count: (count) => count + 1 }) }),

    ChangedResetDuration: ({ seconds }) => ({ model: modifyFields(model, { resetDuration: () => seconds }) }),

    ClickedResetAfterDelay: () => ({
      model: modifyFields(model, { isResetting: () => true }),
      commands: [DelayReset({ seconds: model.resetDuration })],
    }),

    CompletedDelayReset: () => ({ model: modifyFields(model, { count: () => 0, isResetting: () => false }) }),

    // The one place a Command is stopped: `update` returns the Interrupt, so
    // "cancel" is a fact the Model can be asked about rather than an imperative
    // call buried in a handler.
    ClickedCancelDelayReset: () => ({
      model,
      commands: [DelayReset.Interrupt((outcome) => CounterMessage.CompletedCancelDelayReset({ outcome }))],
    }),

    // The interruption reported what it stopped, and the Model says so rather
    // than the runtime guessing: a reset that was cancelled is not a reset.
    CompletedCancelDelayReset: ({ outcome }) => ({
      model: modifyFields(model, { isResetting: () => (outcome as { _tag: string })?._tag !== 'NotFound' }),
    }),
  })

export const init: CounterModel = { count: 0, isResetting: false, resetDuration: 2 }

/** The Submodel declaration. Identity only - the runtime looks inside it once. */
export const Counter = Submodel.define<CounterModel, CounterMessage, never, never>({
  name: 'Counter',
  Model: CounterModel,
  init: () => ({ model: init }),
  update,
  view: counterView,
})

const styles = {
  panel: { alignItems: 'center', gap: 12, paddingVertical: 8 },
  count: { fontSize: 56, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: '#3b6ef5' },
  quiet: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: '#d7dbe0' },
  cancel: { paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: '#e06a5a' },
  label: { color: '#ffffff', fontWeight: '600', fontSize: 15 },
  quietLabel: { color: '#20242a', fontWeight: '600', fontSize: 15 },
  field: {
    minWidth: 72,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#b7bdc6',
    textAlign: 'center',
    fontSize: 16,
  },
  caption: { color: '#5b636e', fontSize: 13 },
}

function counterView(model: CounterModel, h: NativeViewBuilder<CounterMessage>): VNode {
  return h(
    'view',
    { style: styles.panel, testID: 'counter' },
    h('text', { style: styles.count, testID: 'count' }, String(model.count)),
    h(
      'pressable',
      {
        style: styles.button,
        accessibilityRole: 'button',
        accessibilityLabel: 'Increment',
        testID: 'increment',
        onPress: () => CounterMessage.ClickedIncrement(),
      },
      h('text', { style: styles.label }, 'Increment'),
    ),
    h(
      'view',
      { style: styles.row },
      h('text', { style: styles.caption }, 'Reset Delay (seconds)'),
      h('text-input', {
        style: styles.field,
        accessibilityLabel: 'Reset delay in seconds',
        testID: 'reset-duration',
        // A native field, not a styled rectangle: the keyboard, the caret and
        // the platform's own text selection all come with it.
        value: String(model.resetDuration),
        keyboardType: 'number-pad',
        onChange: (value) => CounterMessage.ChangedResetDuration({ seconds: Number.parseInt(value, 10) || 1 }),
      }),
    ),
    model.isResetting
      ? h(
          'pressable',
          {
            style: styles.cancel,
            accessibilityRole: 'button',
            accessibilityLabel: 'Cancel reset',
            testID: 'cancel',
            onPress: () => CounterMessage.ClickedCancelDelayReset(),
          },
          h('text', { style: styles.label }, 'Cancel reset'),
        )
      : h(
          'pressable',
          {
            style: styles.quiet,
            accessibilityRole: 'button',
            accessibilityLabel: 'Reset After Delay',
            testID: 'reset',
            onPress: () => CounterMessage.ClickedResetAfterDelay(),
          },
          h('text', { style: styles.quietLabel }, 'Reset After Delay'),
        ),
  )
}