# Learnings

The bugs, in the order they were found, what each one actually was, and what it
cost. Written from the failures rather than the successes, because the failures
are the ones that teach.

---

## The one thing still unproven

**The app has never been confirmed rendering on a device.**

Everything below the bootstrap is verified — 68 tests, including the renderer
driving the real engine against a fake Fabric, and `expo export` producing
Hermes bytecode for iOS and Android. The bootstrap is now correct by the
reference implementation's own account of itself. It has not been run since.

That is the first thing to do:

```bash
npm run demo      # exp://<your-lan-ip>:8081 in Expo Go
```

Expect `[todo] running — rootTag=… · N native nodes · 1 commit(s)` and a Todo
list.

---

## 1. A service that was acquired, released, and never given to anything

**Found by** writing the test for untested code. It failed immediately.

A `ManagedResource` held a service correctly, acquired it when the Model enabled
it and released it when the Model did not. It also never provided it. A Command
that declared a requirement on the service would have hit a missing-service
defect, while the acquire and release code looked finished.

The root cause was a design gap rather than a typo: `acquire: Effect<Services>`
gave no key to provide the service *under*, so there was nowhere for the wiring to
go. The runtime could acquire and release and never once read the value back.

```ts
// The runtime, after
const managedServices = (): Context.Context<never> | undefined => {
  if (heldResources.size === 0) return undefined
  let context: Context.Context<never> | undefined
  for (const held of heldResources.values()) {
    if (held.key === undefined) continue
    context = context === undefined
      ? Context.add(Context.empty(), held.key, held.service)
      : Context.add(context, held.key, held.service)
  }
  return context
}
```

Built fresh on every use, not cached — which is what makes a release effective
*immediately*: a resource the Model has dropped stops being provided, so a
Command still asking for it fails loudly rather than reading through a handle
that has been closed.

**The lesson is the API change, not the fix.** `ManagedResource.make` now
*requires* `key`, and `ManagedResource.lifecycle` exists for a resource with no
service. A resource that acquired something nobody could name would hold a handle
no Command could reach, and the failure mode is invisible.

## 2. `Fiber.interrupt` returns an Effect, and calling it bare stops nothing

**Found by** a subscription test that would not stop.

```ts
Fiber.interrupt(fiber)   // returns Effect<void> — dropped on the floor
```

This reads exactly like an interrupting call and is not one. It fails *silently*:
no error, no log, the fiber runs to completion. Every one of the three call sites
had it right-looking and wrong. Now they all go through one helper that forks the
result.

**The lesson is about a name that lies.** `interrupt` sounds imperative. The only
tell was the return type, and it is in the `.d.ts`, behind the thing you were
scanning for.

## 3. A dual function with inverted arguments

**Found by** the Submodel test, because a fold is the only place the mistake is
observable.

```ts
// fold(model, input) — data first — was calling fold(input)(model)
return arguments.length >= 2 ? fold(first)(second) : fold(first)
```

Every parent embedding a child got a silently wrong Model: the child's input was
treated as the Model and vice versa. It typechecked perfectly.

**The lesson is that arity-based overloads need a test at the call site.** The
type system cannot see the inversion; only executing it can.

## 4. Reordering children forwards instead of backwards

**Found by** a keyed-reorder test producing `bac` instead of `cab`.

The engine's `insertBefore(parent, node, null)` **appends**. A null reference
means "last", not "first". A reorder walk that placed each node before its
intended successor only lands correctly if everything after it is already in
place — so the walk has to run from the end.

**The lesson is that the primitive's contract is the opposite of the intuitive
one**, and only a test that asserts the *order* of a permutation catches it. A
test that checked "all three children still exist" would have passed.

## 5. Two failures a passing typecheck could not see

**Found by** running `expo export`, which `tsc` had no opinion about.

- **Metro resolves a specifier literally.** It does not do the `.js` → `.ts`
  rewrite TypeScript does under `NodeNext`. `import './app.js'` passes `tsc` and
  fails to resolve. Every file used `.js` extensions; every one was wrong.
- **Hermes has no syntax for `import.meta.env`**, which `effect` reads for
  build-time configuration. Any bundle fails with *"`import.meta` is not
  supported in Hermes"*.

Neither is a type error. Neither is visible without bundling, and bundling takes
twenty seconds.

## 6. The engine's dev checks are invisible at `dev: false`

**Found by** running on a phone, after claiming the app worked.

```
ERROR  [angular-native] <text> is used in a template that does not import Text.
```

The engine reports any known element that no front end has claimed. In Angular
that catches a template which forgot to import a component; `@ng-native/components`
claims elements from each primitive's constructor. Foldkit Native has no components
package, so **nothing ever claimed anything** and every element was reported.

One line fixed it — `claimHost(node)` where the renderer creates an element,
because the renderer *is* the front end that owns it.

**Every test in this repo built its engine with `dev: false`**, so the whole suite
was green against code that reported six errors on the first frame. The fix now
has three tests that build with dev on and capture what the engine logs.

**The lesson generalises past this bug:** a check gated behind a flag is a check
that does not run in the suite you have. If the flag matters in development, the
tests should turn it on.

## 7. The one that cost the most: the wrong entry point

**Found by** reading a working implementation. Too late.

The app mounted from a React component registered with `registerRootComponent`,
reading the root tag from `RootTagContext`. Blank screen, no error, four wrong
bisects.

React Native's root tag is shared by the surface and by React's Fabric
reconciler. A root component that renders `null` makes React commit an **empty
child set** for that root — and React commits after its render phase, so its
commit landed *after* the engine's and erased it. One root, two writers, decided
by timing.

The fix is not an ordering trick. It is not booting through React at all:

```ts
AppRegistry.registerRunnable('main', ({ rootTag }) => {
  mount(Number(rootTag), App, getFabricUIManager(), { … })
})
```

A runnable receives the root tag and asks for nothing back. There is no React
tree, so React has no opinion about that root.

### Why it looked like everything else

The engine reported `16 native nodes, 1 commit(s) · running`. The headless render
of the same tree was byte-identical. The screen was blank. All three true at once.

That combination rules out the renderer and points at "the tree arrives, the
surface shows something else" — and the surface's other writer is invisible from
inside the process. **Every layer below was reporting success, truthfully, about
itself.**

### Why it survived four bisects

Each round was a reasonable test and each ruled something out:

| Ruled out | How |
|---|---|
| colours | dumped every prop reaching Fabric; all correct |
| `flex: 1` | a fixed 200×60 view was also invisible |
| nesting | siblings were also invisible |
| "our white drew" | the white was Expo Go's own background |

All legitimate. None aimed at the right layer, because the bug was above the
renderer — in a bootstrap file that had been available as a published npm package
from the first hour.

**The lesson: when adapting a system, read its entry point before writing yours.**
The bootstrap is where the invariants live, it is the part that looks most
obvious, and it is therefore the part most likely to be invented rather than
read.

## 8. Two diagnostics that could not fail

Both shipped in the same debugging session, and both actively misled.

- `engine.commit()` returning `false` was read as *"React did not wipe us"*. It
  returns `false` whenever the engine's own nodes are clean, and the engine
  cannot know the surface was overwritten. The result would have been `false`
  either way. It proved nothing, and I presented it as conclusive.
- `updateConditions` was used to force a commit and its success reported as
  `DID WORK`. It sets `root.subtreeDirty = true` first, so it *always* commits.
  It could not have reported anything else.

**A measurement that cannot come out the other way is not a measurement.** Both
were built to test one hypothesis and were structurally incapable of refuting
it. The next diagnostic should be designed around the answer that would change
what we do — and if no answer would, it is not worth building.

---

## Things that worked

Kept here because knowing what earned its keep is as useful as knowing what did
not.

- **Rendering the same view headlessly and dumping every prop** turned "the
  styles must be wrong" into "the styles are right and the node count matches the
  device exactly", in two minutes. It eliminated the entire styling hypothesis
  that two bisects had been walking through.
- **Reverting each fix and re-running its test.** Three of the four test-found
  bugs were confirmed to have red tests before the fix went in. A test that has
  never failed has not been tested.
- **Reading the skill before running it.** `expo-upgrade` says to delete a
  `babel.config.js` that only contains `babel-preset-expo` — advice that would
  have broken this app on SDK 54. Testing the claim first, then confirming the
  mechanism in `babel-preset-expo`'s own source
  (`options.transformImportMeta !== false`), made the deletion correct for a
  reason that survives the next SDK bump.