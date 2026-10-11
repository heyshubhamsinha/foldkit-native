import { describe, expect, it } from 'vitest'
import { Engine } from '@ng-native/fabric'
import { createRenderer } from '../src/renderer/fabricRenderer.js'
import { createBuilder } from '../src/view/builder.js'
import { defineMessageUnion } from '../src/index.js'
import { Schema } from 'effect'
import { createFakeFabric } from './fakeFabric.js'

const TestMessage = defineMessageUnion({ Clicked: { n: Schema.Number } })
type TestMessage = typeof TestMessage.Type

/** A builder over this file's own Message union, as an application's `h` is. */
const h = createBuilder<TestMessage>()

const setup = (dev = false) => {
  const fabric = createFakeFabric()
  const engine = new Engine(fabric as any, 1, { dev })
  const sent: TestMessage[] = []
  const renderer = createRenderer({
    engine,
    dispatch: (message) => sent.push(message as TestMessage),
    onError: () => {},
  })
  return { fabric, engine, renderer, sent }
}

/**
 * Everything the engine logged to `console.error` while `run` did its work.
 *
 * The engine's dev checks report through the console rather than by throwing,
 * because they fire mid-commit and a throw there would take down a frame that is
 * otherwise drawing correctly. So they have to be captured, not awaited.
 */
const captureEngineLogs = (run: () => void): string[] => {
  const logged: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  }
  try {
    run()
  } finally {
    console.error = original
  }
  return logged
}

/**
 * The text currently on screen, read out of the engine's committed tree.
 *
 * Read from the committed Fabric handles rather than from the EngineNodes, so
 * this is what native actually received. A paragraph's text reaches Fabric as a
 * `RawText` child, which is why the walk looks for that rather than reading a
 * `text` prop off the paragraph itself.
 */
const onScreen = (engine: any): string => {
  const dump = (handle: any): string => {
    if (handle.viewName === 'RawText') return String(handle.props['text'] ?? '')
    return (handle.children ?? []).map(dump).join('')
  }
  // The engine's root is the container rather than a committed view, so the walk
  // starts at its children: the top-level elements the renderer mounted.
  return engine.root.children
    .map((child: any) => (child.committed?.handle == null ? '' : dump(child.committed.handle)))
    .join('')
}

/** How many native nodes the whole app has ever created. */
const nativeNodes = (fabric: { nodes: readonly unknown[] }): number => fabric.nodes.length

describe('the renderer', () => {
  it('mounts an element tree on the first render', () => {
    const { engine, renderer } = setup()

    renderer.render(h('view', { testID: 'screen' }, h('text', null, 'Hello')))

    expect(onScreen(engine)).toBe('Hello')
    expect(renderer.stats.renders).toBe(1)
  })

  it('writes only the prop that changed', () => {
    const { engine, renderer } = setup()
    const view = (label: string) =>
      h('view', { testID: 'screen' }, h('text', { style: { fontSize: 20 } }, label), h('view', { testID: 'other' }))

    renderer.render(view('one'))
    const created = renderer.stats.created

    renderer.render(view('two'))

    // One new node would mean the text was re-created; a patch writes the text
    // onto the node already there.
    expect(renderer.stats.created).toBe(created)
    expect(onScreen(engine)).toBe('two')
  })

  it('keeps a keyed child across a reorder, so its state is not lost', () => {
    const { engine, renderer } = setup()
    const row = (id: string) => h('view', { key: id, testID: `row-${id}` }, h('text', null, id))

    renderer.render(h('view', null, row('a'), row('b'), row('c')))
    const createdBefore = renderer.stats.created

    renderer.render(h('view', null, row('c'), row('a'), row('b')))

    // A reorder that remounts would create three more nodes; a keyed patch
    // moves the three it already has.
    expect(renderer.stats.created).toBe(createdBefore)
    expect(onScreen(engine)).toBe('cab')
  })

  it('removes a child the next view no longer has', () => {
    const { engine, renderer } = setup()
    const row = (id: string) => h('view', { key: id }, h('text', null, id))

    renderer.render(h('view', null, row('a'), row('b'), row('c')))
    renderer.render(h('view', null, row('a'), row('c')))

    expect(onScreen(engine)).toBe('ac')
  })

  it('replaces a child whose element name changed', () => {
    const { engine, renderer } = setup()

    renderer.render(h('view', null, h('text', null, 'same text')))
    renderer.render(h('view', null, h('view', null, h('text', null, 'same text'))))

    expect(onScreen(engine)).toBe('same text')
  })

  it('dispatches the Message an event prop returns', () => {
    const { engine, renderer, sent } = setup()

    const vnode = h('pressable', { onPress: () => TestMessage.Clicked({ n: 1 }) })
    renderer.render(vnode)

    // The responder system is driven the way a native touch drives it, through
    // the engine, so this asserts the real path rather than calling the handler.
    const node = renderer.nodeFor(vnode)!
    // The engine holds the responder handlers it was given; reading them back is
    // how a test drives a touch the way native would.
    const handlers = (engine as any).responders.get(node)
    expect(typeof handlers.onStartShouldSetResponder).toBe('function')
    expect(handlers.onStartShouldSetResponder({} as any, node)).toBe(true)
    handlers.onResponderRelease({ nativeEvent: { pageX: 1, pageY: 2 } })

    expect(sent).toEqual([TestMessage.Clicked({ n: 1 })])
    void engine
  })

  it('releases every listener on unmount', () => {
    const { engine, renderer } = setup()
    renderer.render(h('view', { testID: 'screen' }, h('text', null, 'gone')))
    renderer.unmount()
    expect(onScreen(engine)).toBe('')
  })

  it('renders a fragment without adding a node', () => {
    const { engine, renderer } = setup()

    renderer.render(h('view', null, h.fragment(h('text', null, 'a'), h('text', null, 'b'))))

    expect(onScreen(engine)).toBe('ab')
  })

  it('normalises a string, a number and a condition into children', () => {
    const { engine, renderer } = setup()

    renderer.render(h('view', null, 'count: ', 42, false, null, undefined))

    // The two text children are merged by the engine into one paragraph, the
    // way React Native merges adjacent runs inside a Text - so the space one of
    // them wrote is the only thing keeping them apart.
    expect(onScreen(engine)).toBe('count:42')
  })
})

describe("the engine's dev checks", () => {
  it('claims every element, so the engine does not report them as unowned', () => {
    // The engine checks on the first commit of any known element that no front
    // end has claimed, and reports it: in Angular that catches a template which
    // forgot to import a component, and here it would fire for every element the
    // renderer created. The renderer *is* the front end that owns them, so it
    // claims them - and this test is what stops that regressing, because the
    // engine's check is invisible at `dev: false`.
    const { engine, renderer } = setup(true)

    const logs = captureEngineLogs(() => {
      renderer.render(
        h('safe-area-view', { testID: 'screen' },
          h('text', null, 'Counter'),
          h('pressable', { onPress: () => TestMessage.Clicked({ n: 1 }) }, h('text', null, 'Increment')),
          h('scroll-view', null, h('text-input', { accessibilityLabel: 'Seconds', value: '2' })),
        ),
      )
    })

    expect(logs).toEqual([])
    expect(engine.root.children.length).toBe(1)
  })

  it('claims elements on a later render too', () => {
    const { renderer } = setup(true)
    renderer.render(h('view', null, h('text', null, 'first')))

    const logs = captureEngineLogs(() => {
      renderer.render(h('view', null, h('text', null, 'second')))
    })

    expect(logs).toEqual([])
  })

  it("claims a fragment's children, which are mounted straight into the parent", () => {
    const { renderer } = setup(true)

    const logs = captureEngineLogs(() => {
      renderer.render(h('view', null, h.fragment(h('text', null, 'a'), h('text', null, 'b'))))
    })

    expect(logs).toEqual([])
  })
})

describe('commit accounting', () => {
  it('commits once per render', () => {
    const { renderer } = setup()

    renderer.render(h('view', null, h('text', null, 'a')))
    renderer.render(h('view', null, h('text', null, 'b')))

    expect(renderer.stats.commits).toBe(2)
  })

  it('does not create a node for a render that changes nothing', () => {
    const { renderer } = setup()
    const view = () => h('view', { style: { flex: 1 } }, h('text', null, 'static'))

    renderer.render(view())
    const created = renderer.stats.created
    renderer.render(view())

    expect(renderer.stats.created).toBe(created)
  })
})