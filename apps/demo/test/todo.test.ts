import { describe, expect, it } from 'vitest'
import { Scene, Story } from '@foldkit-native/core'
import * as Todo from '../src/todo'

/**
 * The Todo list's tests, in the two styles the framework ships.
 *
 * A Story drives `update` and never runs an Effect, so it is total over the
 * state machine and finishes in microseconds. A Scene goes through the view and
 * locates elements the way a screen reader would, so it catches a fact the Model
 * handled correctly but the view never drew. Both are here because the list is
 * exactly the kind of feature where only running both is enough.
 *
 * The type arguments on `Story.story` are spelled out rather than inferred:
 * each step helper is standalone, so TypeScript infers the Model as `unknown`
 * from the steps and never reaches `update`. Naming it once per test is cheaper
 * than a helper that hides it.
 */

type Model = Todo.TodoModel
type Message = Todo.TodoMessage

const start = Todo.init
const draft = (text: string) => Story.message<Todo.TodoModel, Todo.TodoMessage>(Todo.TodoMessage.ChangedDraft({ draft: text }))
const pressAdd = () => Story.message<Todo.TodoModel, Todo.TodoMessage>(Todo.TodoMessage.ClickedAdd())
const typeAndAdd = (text: string) => [draft(text), pressAdd()]
const toggle = (id: number) => Story.message<Todo.TodoModel, Todo.TodoMessage>(Todo.TodoMessage.ToggledTodo({ id }))
const remove = (id: number) => Story.message<Todo.TodoModel, Todo.TodoMessage>(Todo.TodoMessage.RemovedTodo({ id }))
const at = (check: (model: Model) => void) => Story.model<Model>(check)

describe('the Todo state machine', () => {
  it('adds a todo, newest first, and clears the draft', () => {
    const final = Story.story<Todo.TodoModel, Todo.TodoMessage>(
      Todo.update,
      Story.given(start),
      draft('buy milk'),
      pressAdd(),
      at((model) => {
        expect(model.draft).toBe('')
        expect(model.todos.map((todo) => todo.text)).toEqual(['buy milk'])
      }),
    )

    expect(final.model.nextId).toBe(2)
  })

  it('refuses an empty or whitespace-only todo', () => {
    Story.story<Todo.TodoModel, Todo.TodoMessage>(
      Todo.update,
      Story.given(start),
      draft('   '),
      pressAdd(),
      at((model) => {
        expect(model.todos).toHaveLength(0)
        expect(model.nextId).toBe(1)
      }),
    )
  })

  it('trims what it stores', () => {
    Story.story<Todo.TodoModel, Todo.TodoMessage>(
      Todo.update,
      Story.given(start),
      draft('  buy milk  '),
      pressAdd(),
      at((model) => expect(model.todos[0]?.text).toBe('buy milk')),
    )
  })

  it('toggles by id, not by position', () => {
    Story.story<Todo.TodoModel, Todo.TodoMessage>(
      Todo.update,
      Story.given(start),
      ...typeAndAdd('first'),
      ...typeAndAdd('second'),
      toggle(1),
      at((model) => {
        expect(model.todos.find((todo) => todo.id === 1)?.isDone).toBe(true)
        expect(model.todos.find((todo) => todo.id === 2)?.isDone).toBe(false)
      }),
      toggle(1),
      at((model) => expect(model.todos.find((todo) => todo.id === 1)?.isDone).toBe(false)),
    )
  })

  it('ignores a toggle for a todo that is not there', () => {
    Story.story<Todo.TodoModel, Todo.TodoMessage>(
      Todo.update,
      Story.given(start),
      ...typeAndAdd('first'),
      toggle(99),
      at((model) => expect(model.todos).toHaveLength(1)),
    )
  })

  it('ignores a removal for a todo that is not there', () => {
    Story.story<Todo.TodoModel, Todo.TodoMessage>(
      Todo.update,
      Story.given(start),
      ...typeAndAdd('first'),
      remove(99),
      at((model) => expect(model.todos).toHaveLength(1)),
    )
  })

  it('never mutates the Model it was given', () => {
    const before = Todo.init
    const snapshot = JSON.stringify(before)
    Todo.update(before, Todo.TodoMessage.ChangedDraft({ draft: 'x' }))
    Todo.update(before, Todo.TodoMessage.ClickedAdd())
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('the Todo screen', () => {
  const program = { update: Todo.update, view: Todo.todoView }

  it('asks for a todo and shows it', () => {
    Scene.scene(
      program,
      Scene.given(start),
      Scene.type(Scene.label('What needs doing'), 'buy milk'),
      Scene.click(Scene.role('button', { name: 'Add todo' })),
      Scene.expect(Scene.testId('row-1')),
      Scene.expectText('buy milk'),
      Scene.expectText('0 of 1 done'),
    )
  })

  it('shows nothing here yet when the list is empty', () => {
    Scene.scene(program, Scene.given(start), Scene.expect(Scene.testId('empty')), Scene.expectNot(Scene.testId('list')))
  })

  it('does not add an empty todo', () => {
    Scene.scene(
      program,
      Scene.given(start),
      Scene.type(Scene.label('What needs doing'), '   '),
      Scene.click(Scene.role('button', { name: 'Add todo' })),
      Scene.expectNot(Scene.testId('row-1')),
      Scene.expect(Scene.testId('empty')),
    )
  })

  it('ticks a todo and updates the summary', () => {
    Scene.scene(
      program,
      Scene.given(start),
      Scene.type(Scene.label('What needs doing'), 'buy milk'),
      Scene.click(Scene.role('button', { name: 'Add todo' })),
      Scene.click(Scene.role('checkbox', { name: 'buy milk' })),
      Scene.expectText('1 of 1 done'),
    )
  })

  it('removes a todo', () => {
    Scene.scene(
      program,
      Scene.given(start),
      Scene.type(Scene.label('What needs doing'), 'buy milk'),
      Scene.click(Scene.role('button', { name: 'Add todo' })),
      Scene.click(Scene.role('button', { name: 'Delete buy milk' })),
      Scene.expect(Scene.testId('empty')),
    )
  })

  it('keeps the rows it did not touch when one is removed', () => {
    Scene.scene(
      program,
      Scene.given(start),
      Scene.type(Scene.label('What needs doing'), 'first'),
      Scene.click(Scene.role('button', { name: 'Add todo' })),
      Scene.type(Scene.label('What needs doing'), 'second'),
      Scene.click(Scene.role('button', { name: 'Add todo' })),
      // Newest first, so `second` has the lower id and sits above `first`.
      Scene.click(Scene.role('button', { name: 'Delete second' })),
      Scene.expectText('first'),
      Scene.expectText('0 of 1 done'),
    )
  })

  it('finds every row by its own label, which is what makes the list usable', () => {
    Scene.scene(
      program,
      Scene.given(start),
      Scene.type(Scene.label('What needs doing'), 'one'),
      Scene.click(Scene.role('button', { name: 'Add todo' })),
      Scene.type(Scene.label('What needs doing'), 'two'),
      Scene.click(Scene.role('button', { name: 'Add todo' })),
      Scene.expect(Scene.role('checkbox', { name: 'one' })),
      Scene.expect(Scene.role('checkbox', { name: 'two' })),
    )
  })
})