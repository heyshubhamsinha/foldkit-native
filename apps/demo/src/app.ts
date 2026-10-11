/**
 * The application.
 *
 * The Todo list is the whole thing: one Model, five Messages, one pure `update`,
 * one view. There is no parent to fold into and no Submodel boundary, because
 * this app *is* the top level - which is the other half of what the counter
 * demonstrates. The counter needs `foldChild` because it is embedded in
 * something else; this one does not, and adding the indirection anyway would be
 * two layers of ceremony that buy nothing.
 *
 * The five declarations below are the entire contract between an application and
 * this framework. Everything else in the repo is machinery around them.
 */

import { Runtime } from '@foldkit-native/core'
import * as Todo from './todo'

export const app = Runtime.makeApplication<Todo.TodoModel, Todo.TodoMessage>({
  Model: Todo.TodoModel,
  init: () => ({ model: Todo.init }),
  update: Todo.update,
  view: Todo.todoView,
})
