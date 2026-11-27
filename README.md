# Foldkit Native

**Foldkit, rendered as real native iOS and Android views.**

One immutable Model defined by Schema. Messages named for facts. An exhaustive
pure `update`. Side effects as Commands it returns. That is Foldkit's
architecture, and it is Elm's — it was never a web framework's.

What changes here is the other half. A `view` in Foldkit Native does not produce
HTML. It produces a tree of native elements committed to React Native's Fabric
renderer, so a `<view>` is a `UIView` on iOS and an `android.view.View` on
Android, and a `<text>` is a `Paragraph` and a `TextView`. There is no web view,
no DOM emulation, and nothing between your code and the platform.

```
view(model, h)                     a pure function of the Model
      ↓  h('view', …), h('text', …), h('text-input', …)
VNode                               plain data: a name, props, children
      ↓  keyed diff, prop writes, insertions, removals
packages/core/src/renderer          the retained tree and the diff
      ↓  the engine's mutation API
@ng-native/fabric                   retained tree, clone-on-write commit,
                                    responder system, CSS cascade
      ↓  global.nativeFabricUIManager
Fabric C++ / JSI / Yoga             UIKit and Android host views
```

## A component

```ts
import { Effect, Schema } from 'effect'
import { Command, Update, defineMessageUnion, modifyFields } from '@foldkit-native/core'

const CounterModel = Schema.Struct({
  count: Schema.Number,
  isResetting: Schema.Boolean,
  resetDuration: Schema.Number,
})
type CounterModel = typeof CounterModel.Type

const CounterMessage = defineMessageUnion({
  ClickedIncrement: {},
  ChangedResetDuration: { seconds: Schema.Number },
  ClickedResetAfterDelay: {},
  CompletedDelayReset: {},
})
type CounterMessage = typeof CounterMessage.Type

const DelayReset = Command.define('DelayReset', {
  args: { seconds: Schema.Number },
  messages: [CounterMessage.CompletedDelayReset],
  interrupt: true,
  execute: ({ seconds }) =>
    Effect.as(Effect.sleep(`${seconds} seconds`), CounterMessage.CompletedDelayReset()),
})

const update = (model: CounterModel, message: CounterMessage): Update.Return<CounterModel, CounterMessage> =>
  CounterMessage.match(message, {
    ClickedIncrement: () => ({ model: modifyFields(model, { count: count => count + 1 }) }),
    ChangedResetDuration: ({ seconds }) => ({ model: modifyFields(model, { resetDuration: () => seconds }) }),
    ClickedResetAfterDelay: () => ({
      model: modifyFields(model, { isResetting: () => true }),
      commands: [DelayReset({ seconds: model.resetDuration })],
    }),
    CompletedDelayReset: () => ({ model: modifyFields(model, { count: () => 0, isResetting: () => false }) }),
  })

const view = (model: CounterModel, h: NativeViewBuilder<CounterMessage>) =>
  h(
    'safe-area-view',
    { style: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 } },

    h('text', { style: { fontSize: 56, fontWeight: '700' }, testID: 'count' }, String(model.count)),

    h(
      'pressable',
      {
        style: { paddingHorizontal: 22, paddingVertical: 14, borderRadius: 14, backgroundColor: '#3b6ef5' },
        accessibilityRole: 'button',
        accessibilityLabel: 'Increment',
        onPress: () => CounterMessage.ClickedIncrement(),
      },
      h('text', { style: { color: '#ffffff', fontWeight: '600' } }, 'Increment'),
    ),
  )
```

An event handler **returns a Message**. It does not dispatch anything, and it
cannot: the only way a Message reaches the runtime is by being returned, and the
runtime puts it through `update` like any other fact. A tap and a network response
are handled in the same place, by the same exhaustive `match` — and an event prop
carrying something that is not a Message fails to typecheck.

## Why it is Foldkit and not React Native

The architecture is the one Foldkit ships on the web. Your `Model`, your
Messages, your `update` and your Commands move to a native target unchanged. What
is Foldkit Native is the runtime underneath: a retained tree diffed against
Fabric, the responder system for presses, and subscriptions whose lifetimes come
from the Model.

**Predictable state.** One immutable Model. Every change flows through one pure
function. No stale closures.

**Explicit effects.** Side effects are values `update` returns, not calls buried in
handlers. A Command that `update` builds and then discards runs nothing at all —
`execute` is not called when the Command is constructed.

**Shared structure.** A five-file application has the same shape as a fifty-file
one: Model, Message, update, view. A new feature means a Message and an arm of
one `match`.

## Submodels

A Submodel embeds its own Model, Messages, `update` and `view` in a larger
program, through two declarations that must agree:

```ts
// The state half: reads a slice, runs the child's update, writes it back,
// lifts the child's Commands into the parent's Messages.
const foldCounter = Update.foldChild({
  update: Counter.update,
  read: (model: Model) => Option.some(model.counter),
  write: (model, next) => modifyFields(model, { counter: () => next }),
  toParentMessage: message => GotCounterMessage({ message }),
})

// The view half.
const view = (model: Model, h: NativeViewBuilder<Message>) =>
  h('view', null, h.submodel(Counter, model.counter, toParent))
```

The parent gains one field on its Model and one Message that says "something
happened in the counter". It does not learn that the counter resets after a
delay, that the delay is interruptible, or how many ways the counter can change.
Every transition stays in the child.

## Tests that need no simulator

**A Story** drives the pure `update`. The Effects never run: the test *is* the
world, and says what the world did. A Command whose body needs a network or a
ten-second clock is covered in microseconds.

```ts
Story.story<TodoModel, TodoMessage>(
  Todo.update,
  Story.given(Todo.init),
  Story.message(Todo.TodoMessage.ChangedDraft({ draft: 'buy milk' })),
  Story.message(Todo.TodoMessage.ClickedAdd()),
  Story.model<TodoModel>((model) => {
    expect(model.todos.map((todo) => todo.text)).toEqual(['buy milk'])
  }),
)
```

**A Scene** goes through the `view` and locates elements by accessibility label
and role — the way a screen reader would, so a passing Scene is also a check
that the screen is navigable.

```ts
Scene.scene(
  { update: Todo.update, view: Todo.todoView },
  Scene.given(Todo.init),
  Scene.type(Scene.label('What needs doing'), 'buy milk'),
  Scene.click(Scene.role('button', { name: 'Add todo' })),
  Scene.expect(Scene.testId('row-1')),
  Scene.expectText('0 of 1 done'),
)
```

Both run in Node. There is no simulator in the loop, and the renderer tests drive
the real Fabric engine against a fake Fabric, so a test that passes is testing
the code that ships.

## Elements

Every name is a real Fabric component. Nothing is a styled rectangle.

| | |
|---|---|
| `view` `div` `section` `header` `footer` `main` | layout boxes |
| `text` `span` `p` `h1`–`h6` `label` `strong` `em` | paragraphs |
| `scroll-view` `safe-area-view` `virtual-list` `refresh-control` | scrolling |
| `pressable` `touchable-opacity` | touch, through the responder system |
| `text-input` `switch` `image` `modal` `activity-indicator` | the real controls |

A `text-input` is a `UITextField` / `EditText`: the keyboard, the caret, the
platform's text selection and the system's autofill all come with it, because
there is no input element to reimplement.

## The example

`apps/demo` is a chat, rebuilt from
[margelo/ai-chat-demo-with-rag](https://github.com/margelo/ai-chat-demo-with-rag)
on this architecture. A conversation that streams token by token from Apple's
on-device model, can be stopped mid-sentence, keeps a chat history, attaches
photos, and renders replies as markdown parsed into native text elements — no key,
no network, no server.

The part worth reading is `apps/demo/src/chat/model.ts`. The streaming is not
driven by a flag anywhere: the subscription watches the request the Model says it
wants answered, and because `activeRequest` leaves the in-flight reply out, a token
arriving cannot change it. One string encodes every transition — a token, a stop, a
new message — and there is no second condition to keep in agreement with the first.

```bash
npm install
npm test          # 103 tests, no simulator
npm run ios       # a development build — Apple Foundation Models is a native module
```

Requires iOS 26+ on Apple Intelligence hardware. Android runs the app; the model
is not there, and the app says so rather than failing quietly.

## Documentation

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how it is built, and why each rule is load-bearing |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | how this was verified, and what each check can and cannot see |
| [docs/LEARNINGS.md](docs/LEARNINGS.md) | the bugs, in the order they were found, and what each one cost |
| [AGENTS.md](AGENTS.md) | the short list for anyone changing this |

## Status

Alpha. The architecture, the renderer, Commands, interruption, subscriptions,
managed resources, Submodels and both test styles are implemented and tested.
**The device run is not yet confirmed** — see
[docs/LEARNINGS.md](docs/LEARNINGS.md#the-one-thing-still-unproven). Navigation,
DevTools and MCP are not built. APIs can change between `0.x` releases.

The demo's retrieval half was dropped: `@react-native-ai/apple` executes tool calls
itself, so a tool call never becomes a Message and `update` cannot drive the loop.
See [docs/LEARNINGS.md](docs/LEARNINGS.md#10-a-tool-loop-the-provider-would-not-give-up).

## Credits

- **[Foldkit](https://foldkit.dev)** — the architecture, the Message and Command
  model, and the Story/Scene split. This is that framework, rendered natively.
- **[Angular Native](https://github.com/ng-native/ng-native)** — wrote
  `@ng-native/fabric`, the retained tree and commit engine this renders through,
  and its entry point answered the one question this project got wrong. Nothing
  is forked; it is a dependency.

## License

MIT. Foldkit Native is an independent project and is not affiliated with
Foldkit, ng-native or Meta.