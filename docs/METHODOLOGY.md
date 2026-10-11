# Methodology

How this project is verified, and — more usefully — **what each check can and
cannot see**. Most of the bugs in [LEARNINGS.md](LEARNINGS.md) got through
because a check that was passing was being read as more than it was.

## The four checks

| Check | Command | Sees | Blind to |
|---|---|---|---|
| **Types** | `npm run typecheck` | shapes, variance, exhaustiveness | everything at runtime |
| **Tests** | `npm test` | behaviour, in Node, no simulator | the bundler, the device |
| **Bundle** | `npm run bundle` | module resolution, syntax, transform | whether anything *draws* |
| **Device** | `npm run demo` | the truth | — |

None is a substitute for another, and the two that got through everything were
the ones treated as sufficient.

### Types

`strict`, plus `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and
`noImplicitOverride`. The strictness that earned its keep was in the *public
types* rather than the implementation — a `Command` definition with no args must
be callable with no args, and a step helper must not narrow a Message union to the
one variant it was handed. Both were caught here, and both would have been
confusing at every call site forever.

### Tests

Sixty-eight, in Node, no simulator. Three kinds, each answering one question:

- **Renderer** — the diff and the commit, against the *real* engine on a fake
  Fabric. Not a mock: it implements the same `FabricUIManager` interface, so the
  shipping code path is what runs.
- **Runtime** — the fold loop, Commands, interruption, subscriptions and managed
  resources, through a headless host.
- **Story and Scene** — the two public test styles. An example that does not run
  is worse than no example, so `apps/demo` is tested too.

**A test that cannot fail is not a test.** Each fix in
[LEARNINGS.md](LEARNINGS.md) was applied to its change, reverted, and the test
re-run to confirm it went red. Three of the four were caught this way; the
fourth had no test at all, which is how it got that far.

### Bundle

`expo export`, producing Hermes bytecode for both platforms. It needs no
simulator and it caught two failures that `tsc` was green through:

- Metro resolves a specifier **literally** and does not do the `.js` → `.ts`
  rewrite TypeScript does under `NodeNext`. `import './app.js'` passes `tsc` and
  fails to resolve.
- Hermes has no syntax for the `import.meta.env` that `effect` reads.

Both are invisible to the type checker. Both are fatal. **Bundle is part of the
definition of done**, and it costs about twenty seconds.

### Device

The only oracle for what actually renders. The cost is that it is slow and
round-trips through a person, which is exactly why the log has to carry the
weight:

```ts
AppRegistry.registerRunnable('main', ({ rootTag }) => {
  const surface = mountNative({ rootTag, … })
  const handle = mountNativeProgram(app, surface, …)
  console.log(`[todo] running — rootTag=${rootTag} · ${createdNodes} native nodes · ${commits} commit(s)`)
})
```

Two rules that came out of getting this wrong:

**Tail the log; do not ask someone to relay it.** They cannot see it either.

**A diagnostic must be able to come out the other way.** `engine.commit()`
returns `false` whenever the engine's own nodes are clean — and the engine
cannot know that something else overwrote the surface. I read that `false` as
"React did not wipe us", presented it as conclusive, and sent two more rounds on
a dead end. `updateConditions` marks the root dirty by construction, so it
"worked" no matter what. **Both of my startup diagnostics were incapable of
disproving the hypothesis they were built to test.** A measurement that always
returns the same value is not a measurement.

## Comparing against ground truth

The single most useful technique during the device debugging was rendering the
*same* view through the real engine on the fake Fabric, in Node, and dumping
every prop that reached Fabric:

```
<SafeAreaView> bg=#101418 #screen
  <Paragraph> color=#15191e #title
    "Counter"
```

That turned "the screen is blank, something must be wrong with the styles" into
a specific claim: the styles are correct, the node count matches the device
exactly, so the problem is not in this tree at all. It cost two minutes and
eliminated the entire styling hypothesis — which two of the four bisects had been
wandering through.

**When output looks wrong, get ground truth before forming a theory.**

## Bisecting a black screen

A device-only failure has to be narrowed by halves, and the half that matters is
usually *which layer is lying*, not which line is wrong. Each round should change
one variable and be designed so both answers are informative.

What that run actually taught, recorded because the process is the lesson:

| Round | Hypothesis | What it actually ruled out |
|---|---|---|
| 1 | text colour = background | styles correct, node count matched |
| 2 | `flex: 1` / SafeAreaView | fixed 200×60 view also invisible |
| 3 | parent paints, children don't | siblings also invisible |
| 4 | "white = ours drew" | the white was Expo Go's own background |

Every round was a legitimate test. **None of them was aimed at the right layer**,
because the bug was above the renderer entirely — in a bootstrap file that had
never been read from a project that works.

## Reading the working implementation first

The root-tag bug was answered in six lines of
[`@ng-native/template`'s entry point](https://github.com/ng-native/ng-native):

```ts
AppRegistry.registerRunnable('main', ({ rootTag }) => {
  mount(Number(rootTag), App, getFabricUIManager(), { ... })
})
```

That file was available from the first hour, as a published npm package. Reading
it would have saved four bisects and several hours. **When adapting an existing
system, read its entry point before writing yours.** The part that bootstraps is
where the invariants live, and it is the part that looks most obvious — which is
exactly why it is the part that gets invented instead of read.

## What is still unverified

- **The app has never been confirmed rendering on a device.** Everything below the
  bootstrap is verified by tests and by bundling; the bootstrap itself is fixed
  but unconfirmed. See
  [LEARNINGS.md](LEARNINGS.md#the-one-thing-still-unproven).
- **iOS only.** Android bundles but has never been run.
- **ManagedResources** are acquired and released, but a partially-failed group is
  not unwound — recorded in ARCHITECTURE.md rather than tested.
- **The CSS cascade** is inert. The engine has one; nothing compiles CSS at build
  time, so `class` props do nothing. Styles are inline objects.