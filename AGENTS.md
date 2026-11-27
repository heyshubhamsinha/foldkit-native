# AGENTS.md

How this repository is put together, and what a change here has to respect.

## Layout

```
packages/core     @foldkit-native/core — the framework
apps/demo         the chat, running on a device
docs              ARCHITECTURE.md — why it is shaped this way
```

`packages/core` is the only published package. `apps/demo` is private and exists
to prove the core works against a real device surface.

## Commands

```bash
npm test          # vitest — 103 tests, no simulator, no watch
npm run build     # tsc, into packages/core/dist
npm run typecheck # core, then the demo
npm run bundle    # expo export — the demo as Hermes bytecode, no simulator
npm run demo      # expo start --dev-client
```

A change is done when `npm test`, `npm run typecheck` and `npm run bundle` all
pass.

**`npm run bundle` is not optional, and neither is reading its output.** Typechecking
passed on a demo that could not load: Metro resolves a specifier literally and does
not do the `.js` → `.ts` rewrite `tsc` does. That is not a type error. Bundling is
the only check that sees it, and it needs no simulator.

It is also the only check that sees a branch the bundler *deleted*. A guard on
`process.env.EXPO_PUBLIC_*` folds at build time, and everything after it is removed
from the binary — while the app keeps behaving correctly, because the branch was
true. That happened here; see `docs/LEARNINGS.md#9`. When a change adds a
conditional around code that only runs in some builds, grep the exported bundle for
a string that must be in it.

**`apps/demo` needs a development build, not Expo Go.** `@react-native-ai/apple` is
a native module, so `npm run demo` serves a dev client and `npm run ios` builds one.
`expo start` alone will start, and the model will not be there.

An earlier `babel.config.js` set `unstable_transformImportMeta`, because Hermes
had no syntax for the `import.meta.env` that `effect` reads. **SDK 57 enabled
that transform by default** (`options.transformImportMeta !== false` in
`babel-preset-expo`), so the file is gone. If a future SDK ever needs it back,
the error names the flag.

**The device is the only oracle for what actually renders.** The engine commits
16 nodes and reports one commit, the headless render of the same tree is
byte-identical, and the screen is blank - all three true at once. Log what the
device reports, and tail it rather than asking someone to relay it.

## The rules that are load-bearing

The full argument is in `docs/ARCHITECTURE.md`. The short version, in the order
you are most likely to break them:

**`update` is pure.** `Update.Return<Model, Message>` has nowhere to put a side
effect. Do not add one.

**`Command.define` does not run `execute`.** Constructing a Command is pure.
Only the runtime executes.

**Never call `Fiber.interrupt` and drop the result.** It *returns* an Effect.
The runtime's `interrupt` helper is the one place that runs it. Calling it bare
stops nothing and fails silently — this cost a real debugging session.

**Dispatching does not interrupt.** Only an Interrupt Command returned from
`update` stops work.

**A Message is the only way into the state.** Taps, Command results,
subscription ticks, pushes and MCP dispatches all produce one and all go
through the same queue.

**The renderer's reorder walk runs backwards.** The engine's `insertBefore`
detaches before it looks up the reference, and `null` means append. Changing
that loop to go forwards silently mis-places children.

**`cloneNodeWithNewChildren` in the fake Fabric returns empty children.** That is
Fabric's actual semantic. Copying the old children across makes every removal
test fail for the wrong reason.

**Boot with `AppRegistry.registerRunnable`, never `registerRootComponent`.** The
runnable hands over the `rootTag` and there is no React tree at all, so React never
commits to that root and never clears it. `registerRootComponent` mounts a React
component into the same root; React commits an *empty* child set for anything that
renders `null`, and that commit lands after the engine's and erases it. Blank
screen, nothing logged, because nothing threw. This cost four wrong bisects - see
`docs/LEARNINGS.md`.

**The renderer claims every element it creates.** `claimHost` marks an element
as owned by the front end that made it. The engine reports any known element that
is *not* claimed - in Angular that catches a template which forgot to import a
component, and here it fires for every element, because claiming is something
`@ng-native/components` does and there is no components package. Visible only at
`dev: true`, so `renderer.test.ts` builds its engine with dev on.

**A `ManagedResource` must declare the `key` its service is provided under.**
`ManagedResource.make` requires it; `ManagedResource.lifecycle` is for a resource
with no service. A resource that acquired something nobody could name would hold a
handle no Command could reach - the acquire and release would both run, the code
would look finished, and the service would be unreachable.

## Conventions

- Comments explain *why*, and say what the alternative would break. A comment
  restating the line below it is noise; delete it.
- Comments that record a bug that was fixed here (`packages/core/test/fakeFabric.ts`,
  `packages/core/src/renderer/fabricRenderer.ts`) are kept deliberately — they
  are the shortest explanation of why the code looks unusual.
- Files open with a block comment saying what the module is for and what the
  reader would otherwise have to reconstruct.
- Element names are lowercase and hyphenated, because that is what the engine
  knows. Never introduce a mapping layer.
- Relative imports in `apps/demo` are **extensionless**. `import './app'` bundles;
  `import './app.js'` passes `tsc` and fails Metro. Use the subpath exports for
  the core (`@foldkit-native/core/platform`), which resolve through `exports`.
- Effects are formatted with trailing commas in call positions, matching the
  codebase. Match the surrounding style rather than a formatter's opinion.

## Dependencies

`@ng-native/fabric` is the engine. Do not fork it, wrap it, or reimplement its
commit path. If something is missing, the right answer is usually a request
upstream.

`effect` is a peer dependency and the foundation of the runtime. Do not add a
second state management library, a signals library, or a virtual DOM.

## Testing

Three kinds, and each answers a different question:

- `runtime.test.ts` — the fold loop, Commands, interruption, subscriptions, driven
  through a headless host.
- `renderer.test.ts` — the diff and the commit, against the real engine on a fake
  Fabric.
- `submodel.test.ts` — embedding, through `foldChild` and `h.submodel`.
- `managedResource.test.ts` — acquire, release, and the service reaching a Command.
- `storyScene.test.ts` — the Story and Scene APIs, which is also how they are
  documented.
- `apps/demo/test/todo.test.ts` — the Todo list, in both styles. Still the smallest
  complete example, and an example that does not run is worse than no example.
- `apps/demo/test/chat.test.ts` — the streaming chat, in both styles.

A new feature needs a Story (pure, total over the state machine) and, if it
introduces UI, a Scene (through the view, located by accessibility label).

**A test that cannot fail is not a test.** Every load-bearing invariant in the chat
was checked by deliberately breaking it and confirming one test went red. Do that
before believing a new one. The one that matters most: the subscription restarts
when its dependency changes, so `activeRequest` must not change when a token
arrives. Nothing in the types, and nothing in a unit test of any single function,
can see that — only a test about when the loop runs.