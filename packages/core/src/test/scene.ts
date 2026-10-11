import type { Message } from '../runtime/runtime.js'
import { createViewBuilder, type NativeViewBuilder } from '../view/submodel.js'
import type { VNode } from '../view/vnode.js'

/**
 * Scene: testing a feature through the view, with no simulator.
 *
 * A Story proves the state machine does what it should. A Scene proves the
 * feature *works*: type into the field, press the button, see the forecast. The
 * difference is that a Scene goes through `view`, so a fact the Model handled
 * correctly but the view never draws is caught here and nowhere else.
 *
 * ```ts
 * test('typing a zip code and pressing Get shows the forecast', async () => {
 *   await scene(
 *     { update, view },
 *     given(model),
 *     type(label('Zip code'), '90210'),
 *     click(role('button', { name: 'Get Weather' })),
 *     expectText('Loading…'),
 *     Command.expect(FetchWeather),
 *     Command.resolve(FetchWeather, SucceededFetchWeather({ weather })),
 *     expectText('Beverly Hills, California'),
 *   )
 * })
 * ```
 *
 * Nothing here is mocked. The `view` function runs, the events it returns are
 * the Messages a device would send, and the locators read the tree by
 * accessibility label and role rather than by an implementation detail - so a
 * Scene that passes is also a check that the screen can be driven by something
 * that cannot see the code.
 */

/** A node in the Scene's tree, with the props a locator matches on. */
export interface SceneNode {
  readonly kind: 'element' | 'text'
  readonly name: string
  readonly props: Readonly<Record<string, unknown>>
  readonly children: ReadonlyArray<SceneNode>
  readonly handlers: Readonly<Record<string, (payload: any) => unknown>>
}

type ViewFn<Model, Msg> = (model: Model, h: NativeViewBuilder<Msg>) => VNode
type UpdateFn<Model, Msg> = (model: Model, message: Msg) => { model: Model; commands?: ReadonlyArray<any> }

/**
 * One step in a Scene. Returns the next, so a sequence reads as a pipeline.
 *
 * `Msg` is `any` here for the same reason as in a Story: a standalone helper is
 * typed from the one Message it is handed, so pinning it would reject every step
 * after the first. What is *not* lost is the part that matters - the locators
 * read the real tree the real `view` produced, and `update` still matches
 * exhaustively, so a step that should have failed still does.
 */
export type Step<Model, Msg extends Message> = (scene: Scene<Model, any>) => void

/** Every node under a root, root first. */
const walk = (node: SceneNode | null): SceneNode[] => {
  if (node === null) return []
  return [node, ...node.children.flatMap(walk)]
}

/** The text a screen reader would read for a node. */
const readText = (node: SceneNode): string => {
  if (node.kind === 'text') return String(node.props['text'] ?? '')
  return node.children.map(readText).join('')
}

const only = (found: SceneNode[], describe: string): SceneNode => {
  if (found.length === 0) throw new Error(`No element matching ${describe} is on screen`)
  return found[0]!
}

// --- Locators ---------------------------------------------------------------

/**
 * Finds the one element carrying this accessibility label.
 *
 * Matching on the label rather than on a `testID` is what makes a Scene test
 * double as an accessibility check: a control nobody can name is a control
 * nobody on a screen reader can find either.
 */
export const label =
  (name: string) =>
  (node: SceneNode): SceneNode =>
    only(walk(node).filter((candidate) => candidate.props['accessibilityLabel'] === name), `the label '${name}'`)

/** Finds the element with this accessibility role, optionally with this name. */
export const role =
  (roleName: string, options: { readonly name?: string } = {}) =>
  (node: SceneNode): SceneNode =>
    only(
      walk(node).filter((candidate) => {
        if (candidate.props['accessibilityRole'] !== roleName) return false
        return options.name === undefined || candidate.props['accessibilityLabel'] === options.name
      }),
      `the role '${roleName}'${options.name === undefined ? '' : ` named '${options.name}'`}`,
    )

/** Finds the element with this testID. Reach for `label` and `role` first. */
export const testId =
  (id: string) =>
  (node: SceneNode): SceneNode =>
    only(walk(node).filter((candidate) => candidate.props['testID'] === id), `the testID '${id}'`)

/** Finds the element whose text is exactly this. */
export const text =
  (value: string) =>
  (node: SceneNode): SceneNode =>
    only(walk(node).filter((candidate) => readText(candidate) === value), `the text '${value}'`)

// --- Steps ------------------------------------------------------------------

/**
 * The starting state.
 *
 * A Scene has no `init` of its own: it starts from the Model the test names, so
 * a test says what it is about rather than replaying a whole application to get
 * there.
 */
export const given =
  <Model, Msg extends Message>(model: Model) =>
  (scene: Scene<Model, any>): void =>
    scene.seed(model)

/**
 * Asserts the Model at this point in the sequence.
 *
 * The same shape as in a Story: a Scene drives through the view, but a fact's
 * meaning is still decided in `update`, and a test that cannot see the Model
 * would be asserting on pixels alone.
 */
export const model =
  <Model>(check: (model: Model) => void) =>
  (scene: Scene<Model, any>): void => {
    check(scene.model)
  }

/** Dispatches a Message, the way a Command completing or a push would. */
export const message =
  (value: any) =>
  (scene: Scene<any, any>): void =>
    scene.dispatch(value)

/** Presses an element, dispatching the Message its `onPress` returns. */
export const click =
  <Model, Msg extends Message>(locate: (node: SceneNode) => SceneNode) =>
  (scene: Scene<Model, any>): void =>
    scene.interact(scene.find(locate), 'onPress', { pageX: 0, pageY: 0 })

/**
 * Types into a text input, dispatching the Message its `onChange` returns.
 *
 * The whole value is sent at once rather than a character at a time, because
 * that is what `onChange` means on both platforms and what a test of behaviour
 * should be asserting.
 */
export const type =
  <Model, Msg extends Message>(locate: (node: SceneNode) => SceneNode, value: string) =>
  (scene: Scene<Model, any>): void =>
    scene.interact(scene.find(locate), 'onChange', value)

/** Flips a switch, dispatching the Message its `onValueChange` returns. */
export const toggle =
  <Model, Msg extends Message>(locate: (node: SceneNode) => SceneNode, value: boolean) =>
  (scene: Scene<Model, any>): void =>
    scene.interact(scene.find(locate), 'onValueChange', value)

/** Asserts that something matching `locate` is on screen. */
export const expect =
  <Model, Msg extends Message>(locate: (node: SceneNode) => SceneNode) =>
  (scene: Scene<Model, any>): void => {
    scene.find(locate)
  }

/** Asserts that nothing matching `locate` is on screen. */
export const expectNot =
  <Model, Msg extends Message>(locate: (node: SceneNode) => SceneNode) =>
  (scene: Scene<Model, any>): void => {
    try {
      scene.find(locate)
    } catch {
      return
    }
    throw new Error('Expected nothing matching that locator to be on screen')
  }

/** Asserts that some element's text is exactly this. */
export const expectText =
  <Model, Msg extends Message>(value: string) =>
  (scene: Scene<Model, any>): void => {
    scene.find(text(value))
  }

/** The Commands a Scene can assert on and resolve. */
export const Command = {
  /** Asserts that a Command was requested. */
  expect:
    (expected: { readonly name: string }) =>
    (scene: Scene<any, any>): void => {
      if (!scene.pending.some((command) => command.name === expected.name)) {
        throw new Error(`Expected the Command '${expected.name}', but none was requested. In flight: ${describe(scene)}`)
      }
    },

  /**
   * Resolves a Command with the Message it would produce, and dispatches it.
   *
   * The Effect is never run, exactly as in a Story: the Scene says what the
   * world did. That is what lets a test cover a Command whose Effect would need
   * a network, a sensor, or a ten-second clock.
   */
  resolve:
    (command: { readonly name: string }, result: any) =>
    (scene: Scene<any, any>): void =>
      scene.resolve(command, result),

  /** Asserts nothing is left in flight. */
  expectNone: (scene: Scene<any, any>): void => {
    if (scene.pending.length > 0) throw new Error(`Expected nothing in flight, but found: ${describe(scene)}`)
  },
}

const describe = (scene: Scene<any, any>): string =>
  scene.pending.length === 0 ? 'none' : scene.pending.map((command) => `'${command.name}'`).join(', ')

// --- The Scene --------------------------------------------------------------

/**
 * A running feature: the real `update`, the real `view`, and a tree of plain
 * objects a locator can read.
 *
 * The runtime is driven directly rather than through a host, because a Scene has
 * one job - to decide what `view` returns after each transition - and the
 * shortest honest way to answer that is to call it.
 */
export class Scene<Model, Msg extends Message> {
  model!: Model
  readonly log: Array<Msg> = []
  pending: Array<any> = []

  private readonly builder = createViewBuilder<Msg>()
  private rendered: SceneNode | null = null

  constructor(
    private readonly update: UpdateFn<Model, Msg>,
    private readonly view: ViewFn<Model, Msg>,
  ) {}

  /** Starts the Scene at a Model, without going through `init`. */
  seed(model: Model): void {
    this.model = model
    this.log.length = 0
    this.pending.length = 0
    this.rerender()
  }

  /** The tree `view` currently produces. */
  tree(): SceneNode | null {
    return this.rendered
  }

  /** Resolves a locator against the current tree, failing the Scene if it misses. */
  find(locate: (node: SceneNode) => SceneNode): SceneNode {
    if (this.rendered === null) throw new Error('The view has rendered nothing yet')
    return locate(this.rendered)
  }

  /**
   * Calls an event prop and dispatches the Message it returns.
   *
   * The same three steps the renderer performs, so a Scene cannot pass against a
   * path the device would not take.
   */
  interact(node: SceneNode, prop: string, payload: unknown): void {
    const handler = node.handlers[prop]
    if (handler === undefined) throw new Error(`<${node.name}> has no '${prop}' handler`)
    const message = handler(payload)
    if (message === undefined || message === null) return
    if (typeof (message as { _tag?: unknown })._tag !== 'string') {
      throw new Error(`An event handler must return a Message, but returned ${JSON.stringify(message)}`)
    }
    this.dispatch(message as Msg)
  }

  /** Puts a Message through `update` and re-renders. */
  dispatch(message: Msg): void {
    this.log.push(message)
    const result = this.update(this.model, message)
    this.model = result.model
    if (result.commands) this.pending.push(...result.commands)
    this.rerender()
  }

  /** Resolves a Command with the Message it would produce. */
  resolve(command: { readonly name: string }, result: Msg): void {
    const index = this.pending.findIndex((pending) => pending.name === command.name)
    if (index < 0) throw new Error(`Cannot resolve '${command.name}': it was never requested. In flight: ${describe(this)}`)
    this.pending.splice(index, 1)
    this.dispatch(result)
  }

  private rerender(): void {
    this.rendered = build(this.view(this.model, this.builder))
  }
}

const emptyNode: SceneNode = { kind: 'element', name: '#fragment', props: {}, children: [], handlers: {} }

/** Builds the VNode tree as plain data a locator can read. */
const build = (vnode: VNode): SceneNode => {
  if (vnode.kind === 'text') {
    return { kind: 'text', name: '#text', props: { text: vnode.value }, children: [], handlers: {} }
  }
  // Fragments are handled by the loop below, which flattens them into the
  // parent's own child list, so an element here carries the rest of the shape.
  if (vnode.kind === 'fragment') return emptyNode

  const props: Record<string, unknown> = {}
  const handlers: Record<string, (payload: any) => unknown> = {}
  for (const [key, value] of Object.entries(vnode.props)) {
    // `key` is identity, never something the view reads.
    if (key === 'key') continue
    if (key.startsWith('on') && typeof value === 'function') handlers[key] = value as (payload: any) => unknown
    else props[key] = value
  }

  const children: SceneNode[] = []
  for (const child of vnode.children) {
    if (child.kind === 'fragment') for (const inner of child.children) children.push(build(inner))
    else children.push(build(child))
  }

  return { kind: 'element', name: vnode.name, props, children, handlers }
}

/**
 * Runs a Scene and resolves when every step has.
 *
 * A Scene is the real `update` and the real `view`; only the surface is
 * replaced. A Scene that passes is therefore a statement about the feature, not
 * about a mock of it.
 */
export const scene = <Model, Msg extends Message>(
  program: { readonly update: UpdateFn<Model, Msg>; readonly view: ViewFn<Model, Msg> },
  ...steps: ReadonlyArray<Step<Model, Msg>>
): Scene<Model, Msg> => {
  const running = new Scene(program.update, program.view)
  for (const step of steps) step(running)
  return running
}

/** Yields to the macrotask queue, for a step that lets a fiber run. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Waits `ms` of real time, for a step that needs a Command's clock to pass. */
export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))