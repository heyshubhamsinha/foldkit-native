/**
 * A Todo list.
 *
 * This is the example that earns the framework. Everything it needs is on the
 * list of things that are awkward with a DOM renderer and unremarkable here: a
 * keyed list that mutates at both ends, a text input bound to a field in the
 * Model, a checkbox, a scroll view, and a row that has to keep its own identity
 * across a reorder.
 *
 * Every row's `key` is the todo's id, so removing the first item does not
 * rebuild the rows under it - which is what keeps a text input's cursor and a
 * row's position when the list shifts.
 *
 * Nothing here reaches for a ref, a key prop on a DOM node, or an effect that
 * syncs two sources of truth. The Model is one immutable value; `update` is a
 * pure function of it; the view is a pure function of it.
 */

import { Schema } from 'effect'
import { Update, defineMessageUnion, modifyFields } from '@foldkit-native/core'
import type { NativeViewBuilder, VNode } from '@foldkit-native/core'

// --- MODEL ------------------------------------------------------------------

export const Todo = Schema.Struct({
  id: Schema.Number,
  text: Schema.String,
  isDone: Schema.Boolean,
})
export type Todo = typeof Todo.Type

export const TodoModel = Schema.Struct({
  /** The field being typed into. Model state, not a component's. */
  draft: Schema.String,
  /** Newest first, so the next id is the highest. */
  todos: Schema.Array(Todo),
  /** Bumped on every add, so ids are stable and unique without a generator. */
  nextId: Schema.Number,
})
export type TodoModel = typeof TodoModel.Type

// --- MESSAGES ---------------------------------------------------------------

export const TodoMessage = defineMessageUnion({
  ChangedDraft: { draft: Schema.String },
  ClickedAdd: {},
  /** The id, not the row: a Message about a row that no longer exists is a no-op. */
  ToggledTodo: { id: Schema.Number },
  RemovedTodo: { id: Schema.Number },
})
export type TodoMessage = typeof TodoMessage.Type

// --- UPDATE -----------------------------------------------------------------

type UpdateReturn = Update.Return<TodoModel, TodoMessage>

/** Trims the draft and refuses an empty one. Pure: the same draft, the same answer. */
const addDraft = (model: TodoModel): Update.Return<TodoModel, TodoMessage> => {
  const text = model.draft.trim()
  if (text === '') return { model }
  return {
    model: modifyFields(model, {
      draft: () => '',
      todos: (todos) => [{ id: model.nextId, text, isDone: false }, ...todos],
      nextId: (nextId) => nextId + 1,
    }),
  }
}

export const update = (model: TodoModel, message: TodoMessage): UpdateReturn =>
  TodoMessage.match<UpdateReturn>(message, {
    ChangedDraft: ({ draft }) => ({ model: modifyFields(model, { draft: () => draft }) }),

    // One fact, one arm, and the list is a new array. Nothing mutates `todos`
    // in place, so the renderer diffs it and only the row that changed is
    // touched.
    ClickedAdd: () => addDraft(model),

    ToggledTodo: ({ id }) => ({
      model: modifyFields(model, {
        todos: (todos) => todos.map((todo) => (todo.id === id ? { ...todo, isDone: !todo.isDone } : todo)),
      }),
    }),

    // Filtered rather than spliced: a Message about an id that is not there
    // leaves the Model alone, which is what makes a stale tap harmless.
    RemovedTodo: ({ id }) => ({
      model: modifyFields(model, { todos: (todos) => todos.filter((todo) => todo.id !== id) }),
    }),
  })

export const init: TodoModel = { draft: '', todos: [], nextId: 1 }

// --- VIEW -------------------------------------------------------------------

/**
 * Every colour is written out.
 *
 * Not a style preference here: with a native renderer there is no browser
 * default to inherit, so a colour nobody wrote is whatever the platform's
 * default happens to be - and on a dark-mode device that default is light.
 * Written colours are the same on both appearances, which is also what makes
 * "why can I not see this" a question this file can answer on its own.
 */
const styles = {
  screen: { flex: 1, backgroundColor: '#101418' },
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12, backgroundColor: '#101418' },
  title: { fontSize: 30, fontWeight: '800', color: '#ffffff' },
  subtitle: { fontSize: 13, color: '#8b95a1', marginTop: 2 },
  composer: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingBottom: 14 },
  input: {
    flex: 1,
    backgroundColor: '#1c2126',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#ffffff',
    fontSize: 16,
  },
  add: {
    backgroundColor: '#2f6bff',
    borderRadius: 12,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  addLabel: { color: '#ffffff', fontWeight: '700', fontSize: 16 },
  list: { flex: 1, paddingHorizontal: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#1c2126',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 8,
  },
  check: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#5a6673',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: '#2f6bff', borderColor: '#2f6bff' },
  tick: { color: '#ffffff', fontSize: 15, fontWeight: '900' },
  text: { flex: 1, color: '#ffffff', fontSize: 16 },
  textDone: { color: '#6b7683', textDecorationLine: 'line-through' },
  remove: { paddingHorizontal: 8, paddingVertical: 4 },
  removeLabel: { color: '#ff6b6b', fontSize: 20, fontWeight: '700' },
  empty: { color: '#6b7683', fontSize: 15, textAlign: 'center', marginTop: 40 },
  footer: { paddingHorizontal: 20, paddingVertical: 12, backgroundColor: '#101418' },
  count: { color: '#8b95a1', fontSize: 13 },
} as const

export const todoView = (model: TodoModel, h: NativeViewBuilder<TodoMessage>): VNode =>
  h(
    'safe-area-view',
    { style: styles.screen, testID: 'screen' },
    h(
      'view',
      { style: styles.header },
      h('text', { style: styles.title, testID: 'title' }, 'Todo'),
      h('text', { style: styles.subtitle }, 'One Model, one pure update, native views'),
    ),
    h(
      'view',
      { style: styles.composer },
      h('text-input', {
        style: styles.input,
        testID: 'input',
        accessibilityLabel: 'What needs doing',
        value: model.draft,
        placeholder: 'What needs doing?',
        placeholderTextColor: '#6b7683',
        onChange: (draft) => TodoMessage.ChangedDraft({ draft }),
        onSubmitEditing: () => TodoMessage.ClickedAdd(),
      }),
      h(
        'pressable',
        {
          style: styles.add,
          testID: 'add',
          accessibilityRole: 'button',
          accessibilityLabel: 'Add todo',
          onPress: () => TodoMessage.ClickedAdd(),
        },
        h('text', { style: styles.addLabel }, 'Add'),
      ),
    ),
    model.todos.length === 0
      ? h('text', { style: styles.empty, testID: 'empty' }, 'Nothing here yet.')
      : h(
          'scroll-view',
          { style: styles.list, testID: 'list' },
          ...model.todos.map((todo) =>
            h(
              'view',
              // The key is what makes this list cheap and correct: a keyed child
              // is matched wherever it moved, so removing the first row does not
              // rebuild the four under it.
              { key: String(todo.id), style: styles.row, testID: `row-${todo.id}` },
              h(
                'pressable',
                {
                  style: todo.isDone ? styles.checkOn : styles.check,
                  testID: `toggle-${todo.id}`,
                  accessibilityRole: 'checkbox',
                  accessibilityLabel: todo.text,
                  accessibilityState: { checked: todo.isDone },
                  onPress: () => TodoMessage.ToggledTodo({ id: todo.id }),
                },
                todo.isDone ? h('text', { style: styles.tick }, '✓') : null,
              ),
              h(
                'text',
                { style: todo.isDone ? styles.textDone : styles.text, testID: `text-${todo.id}` },
                todo.text,
              ),
              h(
                'pressable',
                {
                  style: styles.remove,
                  testID: `remove-${todo.id}`,
                  accessibilityRole: 'button',
                  accessibilityLabel: `Delete ${todo.text}`,
                  onPress: () => TodoMessage.RemovedTodo({ id: todo.id }),
                },
                h('text', { style: styles.removeLabel }, '✕'),
              ),
            ),
          ),
        ),
    h(
      'view',
      { style: styles.footer },
      h('text', { style: styles.count, testID: 'count' }, summary(model)),
    ),
  )

const summary = (model: TodoModel): string => {
  const total = model.todos.length
  if (total === 0) return 'No todos'
  const done = model.todos.filter((todo) => todo.isDone).length
  return `${done} of ${total} done`
}

/** The application. */
export const todoApp = {
  Model: TodoModel,
  init: () => ({ model: init }),
  update,
  view: todoView,
}
