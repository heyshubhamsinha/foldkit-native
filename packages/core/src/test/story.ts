import type { Command as CommandValue } from '../command.js'
import type { Return } from '../update.js'

/**
 * Story: testing the state machine, with no view and no screen.
 *
 * `update` is a pure function, so it can be driven directly. A Story is a
 * sequence of steps against that function - this Message arrives, the Model is
 * now this, this Command was requested, that Command resolved with this Message -
 * and it asserts on the Model between them.
 *
 * ```ts
 * test('resetting clears the count after the delay', () => {
 *   const final = story(
 *     update,
 *     given({ count: 5, isResetting: false, resetDuration: 2 }),
 *     message(ClickedResetAfterDelay()),
 *     model(m => expect(m.isResetting).toBe(true)),
 *     Command.expect(FetchWeather),
 *     Command.resolve(FetchWeather, CompletedDelayReset()),
 *     model(m => expect(m.count).toBe(0)),
 *   )
 * })
 * ```
 *
 * The one thing a Story cannot tell you is whether the view draws it. That is
 * what {@link Scene} is for, and the split is deliberate: a Story is fast and
 * total over the state machine, a Scene goes through the view. Most tests want
 * the first; the ones that want the second are asking "does the right thing
 * appear".
 */

type Update<Model, Message> = (model: Model, message: Message) => Return<Model, Message>

/** The mutable state a Story threads through its steps. */
class StoryState<Model, Message> {
  log: Array<Message> = []
  pending: Array<CommandValue<any, any, any>> = []
  constructor(
    readonly update: Update<Model, Message>,
    public model: Model,
  ) {}

  /**
   * Runs one Message through `update` and folds in what came back.
   *
   * `update` is pure, so calling it here runs nothing but itself. The Commands
   * it returns are collected rather than run, which is what lets a Story decide
   * what the world does next.
   */
  dispatch(value: Message): void {
    const result = this.update(this.model, value)
    this.model = result.model
    this.log.push(value)
    if (result.commands) this.pending.push(...result.commands)
  }
}

/**
 * One step in a Story. Returns the next, so a sequence reads as a pipeline.
 *
 * The state's `Message` is `any` on purpose. Each helper is a standalone
 * function, so TypeScript infers its `Message` from the single Message passed to
 * it - `Story.message(ClickedReset())` would pin the whole sequence to the
 * `ClickedReset` variant and reject every step after it. The check that actually
 * matters is not lost: `update` matches exhaustively over the real union, so a
 * Message that does not belong fails there, at the transition, rather than
 * silently passing.
 */
export type Step<Model, Message> = (state: StoryState<Model, any>) => void

/**
 * The starting state.
 *
 * A Story has no `init` of its own: it starts from the Model the test names, so
 * a test says what it is about rather than replaying a whole application to get
 * there. That is also what makes a Story cheap enough to write one per branch.
 */
export const given =
  <Model, Message>(initial: Model) =>
  (state: StoryState<Model, Message>): void => {
    state.model = initial
  }

/** Dispatches a Message through `update`. */
export const message =
  <Model, Message>(value: Message) =>
  (state: StoryState<Model, Message>): void =>
    state.dispatch(value)

/**
 * Asserts the Model at this point in the sequence.
 *
 * A function rather than a value, so the assertion runs against the live state
 * and a test can read the Model rather than restating all of it.
 */
export const model =
  <Model>(check: (model: Model) => void) =>
  (state: StoryState<Model, any>): void => {
    check(state.model)
  }

/** Asserts the Messages dispatched so far. */
export const log =
  <Model, Message>(check: (dispatched: ReadonlyArray<Message>) => void) =>
  (state: StoryState<Model, any>): void => {
    check(state.log)
  }

/**
 * Runs a Story against an `update` and returns the state it ended in.
 *
 * Steps are applied in order, so the Model a later step sees is the one the
 * earlier steps produced - the same guarantee the runtime gives, which is why a
 * Story is a real account of a transition sequence rather than a set of
 * independent assertions about it.
 */
export const story = <Model, Message extends { _tag: string }>(
  update: Update<Model, Message>,
  ...steps: ReadonlyArray<Step<Model, Message>>
): { readonly model: Model; readonly log: ReadonlyArray<Message>; readonly pending: ReadonlyArray<CommandValue<any, any, any>> } => {
  const state = new StoryState(update, undefined as unknown as Model)
  for (const step of steps) step(state)
  return state
}

/** The Commands a Story can assert on and resolve. */
export const Command = {
  /**
   * Asserts that a Command was requested, and returns the state so it can be
   * used inline: `message(...), Command.expect(Fetch), model(...)`.
   */
  expect:
    (expected: { readonly name: string }) =>
    (state: StoryState<any, any>): void => {
      if (!state.pending.some((command) => command.name === expected.name)) {
        throw new Error(`Expected the Command '${expected.name}', but none was requested. In flight: ${describe(state)}`)
      }
    },

  /**
   * Asserts that exactly these Commands are in flight, by name and in order.
   *
   * Stricter than `expect`, and the one to reach for when `update` should be
   * asking for a particular Command and nothing else.
   */
  expectExact:
    (expected: ReadonlyArray<{ readonly name: string }>) =>
    (state: StoryState<any, any>): void => {
      const names = state.pending.map((command) => command.name)
      const wanted = expected.map((command) => command.name)
      if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) {
        throw new Error(`Expected exactly [${wanted.join(', ')}] in flight, but found [${names.join(', ')}]`)
      }
    },

  /**
   * Resolves a Command with the Message it would produce, and dispatches it.
   *
   * The Effect is never run: the Story *is* the world, and this step says what
   * the world did. That is what lets a test cover a Command whose Effect would
   * need a network, a sensor, or a ten-second clock - and it is why a Story can
   * be finished in microseconds.
   */
  resolve:
    (command: { readonly name: string }, result: any) =>
    (state: StoryState<any, any>): void => {
      const index = state.pending.findIndex((pending) => pending.name === command.name)
      if (index < 0) throw new Error(`Cannot resolve '${command.name}': it was never requested. In flight: ${describe(state)}`)
      state.pending.splice(index, 1)
      state.dispatch(result)
    },

  /** Asserts that nothing is left in flight. */
  expectNone: (state: StoryState<any, any>): void => {
    if (state.pending.length > 0) throw new Error(`Expected nothing in flight, but found: ${describe(state)}`)
  },
}

const describe = (state: StoryState<any, any>): string =>
  state.pending.length === 0 ? 'none' : state.pending.map((command) => `'${command.name}'`).join(', ')

/** Yields to the macrotask queue, for a step that lets a fiber run. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits `ms` of real time, for a step that needs a Command's clock to pass. */
export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))