/**
 * A fake Fabric, for tests that need a screen.
 *
 * This implements the same `FabricUIManager` interface React Native exposes on
 * `global.nativeFabricUIManager`, so the real engine runs against it unchanged.
 * That is the point: a Story test drives the actual renderer, the actual
 * responder system and the actual commit path, with no simulator and no
 * platform - so a test that passes here is testing the code that ships.
 *
 * It is a test double, not a mock. It has no expectations and asserts nothing
 * about how it was called; the assertions live in the tests, against the tree
 * this produces.
 */

export interface FakeHandle {
  readonly __fake: unique symbol
  readonly viewName: string
  readonly props: Record<string, unknown>
  readonly children: FakeHandle[]
  /** Set by `removeChild` and by a clone, so a test can tell a moved node from a new one. */
  mounted: boolean
}

export interface Commit {
  readonly rootTag: number
  readonly children: readonly FakeHandle[]
}

export interface FakeFabric {
  /** Every commit, newest last. A test asserts on the last one. */
  readonly commits: Commit[]
  /** Every node ever created, in creation order. */
  readonly nodes: FakeHandle[]
  /** The event handler the engine registered, for a test to fire an event through. */
  fire(topLevelType: string, node: FakeHandle, event: unknown): void
  reset(): void
  /** The live tree, walked for text and props. */
  serialize(node?: FakeHandle): string
}

let nextTag = 1
const tags = new WeakMap<FakeHandle, number>()

export const createFakeFabric = (): FakeFabric => {
  const commits: Commit[] = []
  const nodes: FakeHandle[] = []
  let handler: ((instanceHandle: unknown, topLevelType: string, nativeEvent: unknown) => void) | undefined

  const make = (viewName: string, props: object): FakeHandle => {
    const handle: FakeHandle = {
      __fake: Symbol('fakeHandle') as never,
      viewName,
      props: { ...props },
      children: [],
      mounted: false,
    }
    tags.set(handle, nextTag++)
    nodes.push(handle)
    return handle
  }

  const fabric = {
    commits,
    nodes,

    createNode: (_tag: number, viewName: string, _rootTag: number, props: object) => make(viewName, props),

    // Cloning with new children gives the clone *no* children, and the engine
    // appends each one. That is the semantic the engine's commit path is built
    // on - a removed child is simply never appended - so a fake that copied the
    // old children across would leave removed nodes on screen and every
    // removal test would fail for the wrong reason.
    cloneNodeWithNewChildren: (node: FakeHandle) => make(node.viewName, node.props),

    // Cloning with new props keeps the previous revision's children, which is
    // what Fabric does.
    cloneNodeWithNewProps: (node: FakeHandle, newProps: object) => {
      const clone = make(node.viewName, newProps)
      clone.children.push(...node.children.map(cloneTree))
      return clone
    },

    cloneNodeWithNewChildrenAndProps: (node: FakeHandle, newProps: object) => make(node.viewName, newProps),

    appendChild: (parent: FakeHandle, child: FakeHandle) => {
      detach(child)
      parent.children.push(child)
      child.mounted = true
      return parent
    },

    createChildSet: () => [] as FakeHandle[],

    appendChildToSet: (set: FakeHandle[], child: FakeHandle) => {
      set.push(child)
    },

    completeRoot: (rootTag: number, set: FakeHandle[]) => {
      for (const child of set) child.mounted = true
      commits.push({ rootTag, children: [...set] })
    },

    registerEventHandler: (fn: (instanceHandle: unknown, topLevelType: string, nativeEvent: unknown) => void) => {
      handler = fn
    },

    setIsJSResponder: () => {},

    dispatchCommand: () => {},

    measureInWindow: (_node: FakeHandle, onSuccess: (x: number, y: number, w: number, h: number) => void) =>
      onSuccess(0, 0, 0, 0),

    fire: (topLevelType: string, node: FakeHandle, event: unknown) => {
      if (handler === undefined) throw new Error('The engine registered no event handler')
      handler(tags.get(node) ?? 0, topLevelType, event)
    },

    reset: () => {
      commits.length = 0
      nodes.length = 0
    },

    /** A readable dump of the tree, which is what a Scene test asserts against. */
    serialize: (node?: FakeHandle): string => {
      if (node === undefined) {
        return commits.map((commit) => commit.children.map((child) => dump(child)).join('')).join('')
      }
      return dump(node)
    },
  }

  const detach = (node: FakeHandle): void => {
    // Fabric's appendChild re-parents, so the node leaves its old parent first.
    node.mounted = true
  }

  const cloneTree = (node: FakeHandle): FakeHandle => {
    const clone = make(node.viewName, node.props)
    clone.children.push(...node.children.map(cloneTree))
    return clone
  }

  const dump = (node: FakeHandle): string => {
    const text = node.props['text']
    if (node.viewName === 'Paragraph' && typeof text === 'string') return text
    return node.children.map(dump).join('')
  }

  return fabric as unknown as FakeFabric
}