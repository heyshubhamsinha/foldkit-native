# Architecture

Fabric's renderer is not coupled to React. Fabric exposes its mutation API on
`global.nativeFabricUIManager`, and React's reconciler is one client of it.
Angular is another, through `Renderer2`. This is a third, and everything here
follows from that one seam: `react-native` and `expo` stay unmodified
dependencies, and nothing is forked.

```
view(model, h)                       a pure function of the Model
      ↓  h('view', …), h('text', …), h('pressable', …)
VNode                                plain data: name, props, children
      ↓  keyed diff, prop writes, insertions, removals
packages/core/src/renderer           the retained tree and the diff
      ↓  the engine's mutation API
@ng-native/fabric                    retained tree, clone-on-write commit,
                                     responder system, CSS cascade
      ↓  global.nativeFabricUIManager
Fabric C++ / JSI / Yoga              UIKit and Android host views
```

## Why an engine rather than a renderer

The mismatch the engine exists to solve is that the Elm Architecture mutates and
Fabric is persistent. A committed node is never edited; it is cloned with new
props or children, and a changed leaf forces every ancestor to re-clone, because
a persistent parent holds references to specific child handles.

`@ng-native/fabric` already owns that rule and performs the cloning during
`commit()`. What it does not own is deciding *what* changed — that is the
renderer's job, and `packages/core/src/renderer/fabricRenderer.ts` is it. The
engine handles the tree; this decides the tree.

Writing a second engine would have meant reimplementing the responder system,
the incremental commit, and the event dispatch, and would have been worse.

## The rules

Each of these is load-bearing. Breaking one does not degrade the architecture,
it invalidates it.

**`update` is pure, and the type says so.** `Update.Return<Model, Message>` is a
record with three fields: the next Model, a list of Commands, and — for a
Submodel reporting to a parent — one OutMessage. There is nowhere in that type
to put a side effect, so `update` cannot perform one. Every async operation in
an application is a Command the runtime runs.

**Constructing a Command runs nothing.** `Command.define` returns a value whose
`execute` has not been called. `update` builds Commands freely; only the runtime
executes them. A Command that `update` builds and then discards runs nothing at
all, which is what makes it safe for `update` to describe work it might not
want.

**Dispatch never interrupts.** A Command is stopped only when `update` returns
an Interrupt Command. That is what keeps "cancel" a decision visible in one
place rather than an imperative call inside a handler. `Fiber.interrupt` returns
an Effect rather than interrupting on the spot, so every call goes through the
runtime's one `interrupt` helper — calling it and dropping the result stops
nothing, and fails silently.

**A Message is the only route into the state.** A tap returns one. A Command's
result is one. A subscription's tick is one. A push notification, a deep link or
an MCP client dispatches one. They all go through the same queue and the same
pure `update`, so a feature cannot work from a push and silently fail from a
button.

**Subscriptions declare dependencies, not the Model.** After each transition
the runtime recomputes a subscription's dependencies and compares them field by
field with the ones its running Stream was started with. Equivalent leaves it
alone; a change tears it down and restarts it. A watcher is therefore never
restarted because an unrelated counter in the same Model changed — which is the
whole reason dependencies are declared separately.

**A ManagedResource declares the key it is provided under.** `make` requires it
and `lifecycle` is for a resource with no service, because a resource that
acquired something and could not say under what name would hold a handle no
Command could ever reach: the acquire and release would both run, the code would
look finished, and the service would be unreachable. Naming the key is what makes
"provides the service" a checkable statement. The runtime builds a Context from
the held resources on every fork, so a resource the Model has dropped stops being
provided immediately rather than handing out a handle that has been closed.

**A Submodel's two halves must agree.** `Update.foldChild` and `h.submodel`
both take the same `toParent` function. If they disagreed, a tap in the child
could produce a Message the parent's `update` does not handle, and the feature
would work in one place and not the other.

**`view` draws nothing.** It returns a VNode: plain data, frozen, holding no
handle to a native node. That is what makes a Scene test able to call it with no
engine, and what lets the renderer diff two of them.

**Element names are the engine's.** `view`, `text`, `text-input`,
`scroll-view`. Each maps to a real Fabric component. There is no mapping layer
that could turn a typo into a styled rectangle.

## The renderer

Between two renders the renderer holds the previous tree beside the new one and
works out the smallest set of prop writes, insertions and removals that turns
one into the other. A view that re-runs because one number changed costs one
prop write, not a new tree — which is the difference between a counter and a
list of a thousand rows on a phone.

Three details that are not obvious and each of which was a bug before it was
correct:

**A fragment is not a node.** `h.fragment(...)` groups siblings without adding a
view. The renderer folds them away, so a helper can return several elements
where the caller expects one and nothing appears on screen for it.

**Keyed children are matched by key, everywhere.** A keyed child is matched
wherever it moved to, which is what keeps a text input's cursor and a row's
scroll position when an item above it is removed. An unkeyed child is matched by
position, so a plain list costs one pass and no bookkeeping.

**Reordering goes backwards.** The engine's `insertBefore` detaches the node
before it looks up the reference, and a null reference means *append*. Placing
each node before its intended successor only lands correctly if everything after
it is already where it belongs, so the walk runs from the end. The last child is
placed first, and the front falls out.

## Why the test host is not a mock

`packages/core/test/fakeFabric.ts` implements the same `FabricUIManager`
interface React Native exposes, so the *real* engine runs against it. Two
details matter:

- **`cloneNodeWithNewChildren` returns a clone with no children**, and the engine
  appends each one. That is the semantic the commit path is built on: a removed
  child is simply never appended. A fake that copied the old children across
  leaves removed nodes on screen, and every removal test fails for the wrong
  reason.
- **`cloneNodeWithNewProps` keeps the previous children**, because Fabric does.

The headless host in `test/testHost.ts` goes further and replaces the renderer
too, because a Story is about `update` and does not need a tree. Both are
double-free in the sense that matters: they assert nothing, and the assertions
live in the tests.

## Who owns the root tag

Nobody has to share it, which is the whole answer.

The app is started from an AppRegistry **runnable**:

```ts
AppRegistry.registerRunnable('main', ({ rootTag }) => {
  mount(Number(rootTag), App, getFabricUIManager(), { ... })
})
```

React Native hands over the root tag and asks for nothing back. There is no React
tree, so React's Fabric reconciler has no opinion about that root and never calls
`completeRoot` on it. The engine is the only writer.

The obvious alternative — `registerRootComponent` with a component that returns
`null` — mounts React into the same root. React then commits an *empty* child set
for it, and because React commits after its render phase, that commit lands after
the engine's and erases it. One root, two writers, and the loser is decided by
timing rather than by argument.

The symptom is the nasty part: the engine reports its nodes created and its
commit done, the headless render of the same tree is identical, and the screen is
blank. Nothing throws, nothing is logged, and every layer below reports success.
It looks exactly like a layout bug, a colour bug, or a missing style — and each of
those was a wrong answer. The argument was in a file that should have been read
before it was written; `@ng-native/platform`'s own entry point answers it in six
lines.

## The engine's dev checks

The engine runs checks at `dev: true` - which is what a development bundle is -
and reports them through `console.error` rather than by throwing, because they
fire mid-commit and a throw there would take down a frame that is drawing
correctly. There are four, and what each means here:

| Check | Fires? | Why |
|---|---|---|
| `checkClaimed` | **used to, on every element** | Claiming is `@ng-native/components`' job and there is no components package, so the renderer claims what it creates. |
| `checkProps` | no | Bails when nothing is declared, and only `@ng-native/components` declares. Latent: installing that package would populate a global registry and make this fire against our props. |
| `checkKnown` | no | Guards names absent from the engine's view table; every element we name is in it. |
| `var()` / display warnings | no | They need a stylesheet. Styles are inline objects. |

None of these is visible at `dev: false`, which is why the renderer tests build
their engine with dev on. That is the whole reason those tests exist: a bundling
check cannot see any of this, and neither can a type check.

## What the bundler needs

Two things, both found by bundling rather than by typechecking, which is why
`npm run bundle` is part of the definition of done.

**There is no Metro config.** Nothing in Foldkit Native needs a build-time
transform: a view is a function call returning plain data, not a template to
compile. Compare a framework whose elements are templates - those need a Metro
preset, a compiler, and a cache to invalidate. This one needs a bundler.

**Effect reads `import.meta.env`, which Hermes has no syntax for.** On SDK 54
this needed a `babel.config.js` setting `unstable_transformImportMeta`, or the
bundle failed with "`import.meta` is not supported in Hermes". SDK 57 enabled
that transform by default, so no config file is needed. Worth knowing because it
is the one place a Foldkit Native bundle ever needed a build-time flag, and it
was about `effect` rather than about this framework.

**Relative imports in an app are extensionless.** Metro resolves a specifier
literally; it does not do the `.js` → `.ts` rewrite `tsc` does under
`NodeNext`. `import './app'` bundles and `import './app.js'` does not, and only
one of them is a type error - which is to say, neither is.

## Non-goals

- No web view, and no Capacitor, Lynx or NativeScript underneath.
- No fork of `react-native` or `expo`.
- No server rendering or hydration: there is no DOM to hydrate.
- No running third-party **React** components. Their bodies call hooks off a
  dispatcher that is null here. Third-party **native views** and TurboModules
  are reachable through `registerViewName`, and that is the reuse path.

## Layers

```
packages/core/src
  schema.ts              defineMessageUnion, defineTaggedUnion
  struct.ts              modifyFields
  command.ts             Command.define, interruption, message lifts
  update.ts              Return, combine, foldChild
  view/
    vnode.ts             the VNode tree
    elements.ts          element names, props, event payloads
    builder.ts           h
    submodel.ts          Submodel.define, h.submodel
  renderer/
    fabricRenderer.ts    the retained tree and the diff
  runtime/
    runtime.ts           the fold loop
    subscriptions.ts     work whose lifetime comes from the Model
    managedResource.ts   services held while the Model needs them
    dispatch.ts          the door in from outside the runtime
  test/
    story.ts             the state machine
    scene.ts             through the view
  platform.ts            the device host: engine + services
```

The dependency direction is one way: `platform` knows about Fabric and the
runtime; `runtime` knows about Messages and VNodes; `renderer` knows about
VNodes and the engine; `command`, `update`, `schema` and `struct` know about
nothing. Nothing below `runtime` imports a platform, which is what lets the
whole runtime be exercised in Node.

## What is not built yet

- **Navigation.** No native stack, no tabs, no deep links. `Route` is where it
  would start: a route union the Model can hold, rather than a router outside it.
- **DevTools and MCP.** `RuntimeHandle` already exposes `model()`, `log()` and
  `dispatch()` — exactly what both need — and `Dispatch.send` is the door. What
  is missing is the UI and the transport.
- **ManagedResources do not unwind a partially-failed group.** Two resources
  where the second fails to acquire leave the first held, with nothing asking for
  it, until the Model changes again.
- **A CSS cascade from a stylesheet.** The engine has one; nothing compiles CSS
  at build time, and `class` props are therefore inert. Styles are inline
  objects today.