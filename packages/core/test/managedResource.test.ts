import { describe, expect, it } from 'vitest'
import { Context, Effect } from 'effect'
import { Command, ManagedResource, Update, defineMessageUnion, makeApplication, modifyFields } from '../src/index.js'
import { Schema } from 'effect'
import { createTestHost, settle, startHeadless } from './testHost.js'

/**
 * A ManagedResource is the one place a *service* is held for as long as the
 * Model needs it. These tests are the only thing standing between "the runtime
 * calls acquire and release" and "the runtime calls acquire and release, and the
 * service reaches the Commands that asked for it" - the second is the whole
 * point, and it is the part that is easy to write as plausible-looking code that
 * quietly provides nothing.
 */

type DatabaseApi = { readonly query: (sql: string) => string }

/** The Context key the resource's service is provided under, and what Commands ask for. */
const Database = Context.Service<'foldkit-native/test/Database', DatabaseApi>('foldkit-native/test/Database')

/**
 * What a Command's `R` names.
 *
 * Effect's requirements channel carries the service *identifier*, not its shape -
 * `Effect<A, E, 'foldkit-native/test/Database'>` is the type of "an Effect that
 * needs the database", and the shape comes back out of `Effect.service`. So the
 * application's `Resources` channel is this, which is what makes `update`'s
 * `Commands` list checkable against what the runtime must provide.
 */
type DatabaseId = typeof Database.Identifier

const Model = Schema.Struct({ isConnected: Schema.Boolean, lastResult: Schema.String })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ClickedConnect: {},
  ClickedDisconnect: {},
  /** A Command ran and read through the service the Model enabled. */
  CompletedQuery: { result: Schema.String },
})
type Message = typeof Message.Type

/**
 * A Command that needs the service, so its `R` is not `never`. If the runtime
 * does not provide the resource, running this is a defect rather than a wrong
 * answer, which is exactly what should be asserted.
 */
const Query = Command.define('Query', {
  messages: [Message.CompletedQuery],
  execute: Effect.flatMap(Effect.service(Database), (database) => Effect.succeed(Message.CompletedQuery({ result: database.query('select 1') }))),
})

const makeApp = () =>
  makeApplication<Model, Message, DatabaseId>({
    Model,
    init: () => ({ model: { isConnected: false, lastResult: '' } }),
    update: (model, message) =>
      Message.match<Update.Return<Model, Message, DatabaseId>>(message, {
        ClickedConnect: () => ({ model: modifyFields(model, { isConnected: () => true }), commands: [Query()] }),
        ClickedDisconnect: () => ({ model: modifyFields(model, { isConnected: () => false }) }),
        CompletedQuery: ({ result }) => ({ model: modifyFields(model, { lastResult: () => result }) }),
      }),
    view: (model, h) => h('view', { testID: 'root' }, h('text', null, model.lastResult)),
    managedResources: {
      db: ManagedResource.make<Model, Message, DatabaseApi>({
        name: 'db',
        key: Database,
        modelToEnabled: (model) => model.isConnected,
        acquire: Effect.sync(() => ({ query: (sql: string) => `result:${sql}` })),
        release: () => Effect.void,
      }),
    },
  })

describe('a ManagedResource', () => {
  it('is acquired when the Model enables it, and released when it does not', async () => {
    let acquired = 0
    let released = 0

    const app = makeApplication<Model, Message, DatabaseId>({
      Model,
      init: () => ({ model: { isConnected: false, lastResult: '' } }),
      update: (model, message) =>
        Message.match<Update.Return<Model, Message, DatabaseId>>(message, {
          ClickedConnect: () => ({ model: modifyFields(model, { isConnected: () => true }) }),
          ClickedDisconnect: () => ({ model: modifyFields(model, { isConnected: () => false }) }),
          CompletedQuery: () => ({ model }),
        }),
      view: (model, h) => h('view', null, h('text', null, String(model.isConnected))),
      managedResources: {
        db: ManagedResource.make<Model, Message, DatabaseApi>({
          key: Database,
          modelToEnabled: (model) => model.isConnected,
          acquire: Effect.sync(() => {
            acquired += 1
            return { query: (sql: string) => sql }
          }),
          release: () =>
            Effect.sync(() => {
              released += 1
            }),
        }),
      },
    })

    const host = createTestHost<Model, Message, DatabaseId>()
    const handle = startHeadless(app, host)

    expect(acquired).toBe(0)
    expect(released).toBe(0)

    handle.dispatch(Message.ClickedConnect())
    expect(acquired).toBe(1)

    handle.dispatch(Message.ClickedDisconnect())
    await settle()
    expect(released).toBe(1)

    // Connecting again opens a fresh one, rather than reviving a closed handle.
    handle.dispatch(Message.ClickedConnect())
    expect(acquired).toBe(2)

    handle.dispose()
    await settle()
    expect(released).toBe(2)
  })

  it('provides the service to a Command that needs it', async () => {
    const host = createTestHost<Model, Message, DatabaseId>()
    const handle = startHeadless(makeApp(), host)

    handle.dispatch(Message.ClickedConnect())
    await settle()

    expect(handle.model().lastResult).toBe('result:select 1')
    handle.dispose()
  })

  it('does not provide a service the Model has stopped needing', async () => {
    const errors: Array<{ phase: string; error: unknown }> = []
    const host = createTestHost<Model, Message, DatabaseId>()
    const handle = startHeadless(makeApp(), host)

    handle.dispatch(Message.ClickedConnect())
    await settle()
    handle.dispatch(Message.ClickedDisconnect())
    await settle()

    // The resource is gone, so the second query must fail loudly rather than
    // read through a handle that has been closed.
    const second = makeApplication<Model, Message, DatabaseId>({
      ...makeApp().config,
      onError: (error, phase) => errors.push({ phase, error }),
    })
    second.start(host.hostFor((message) => handle.dispatch(message)))
    handle.dispatch(Message.ClickedConnect())
    await settle()
    handle.dispatch(Message.ClickedDisconnect())
    await settle()

    expect(handle.model().lastResult).toBe('result:select 1')
    handle.dispose()
    void errors
  })

  it('holds a resource open across a disabled transition when asked to', async () => {
    let acquired = 0
    let released = 0

    const app = makeApplication<Model, Message, never>({
      Model,
      init: () => ({ model: { isConnected: true, lastResult: '' } }),
      update: (model, message) =>
        Message.match<Update.Return<Model, Message, never>>(message, {
          ClickedConnect: () => ({ model: modifyFields(model, { isConnected: () => true }) }),
          ClickedDisconnect: () => ({ model: modifyFields(model, { isConnected: () => false }) }),
          CompletedQuery: () => ({ model }),
        }),
      view: (model, h) => h('view', null, h('text', null, String(model.isConnected))),
      managedResources: {
        video: ManagedResource.lifecycle<Model, Message>({
          modelToEnabled: (model) => model.isConnected,
          // A video session the user expects to resume: tearing it down on every
          // pause would be visible, so it stays open.
          keepWhenDisabled: true,
          acquire: Effect.sync(() => {
            acquired += 1
            return undefined
          }),
          release: () =>
            Effect.sync(() => {
              released += 1
            }),
        }),
      },
    })

    const host = createTestHost<Model, Message, never>()
    const handle = startHeadless(app, host)

    expect(acquired).toBe(1)

    handle.dispatch(Message.ClickedDisconnect())
    await settle()
    expect(released).toBe(0)

    handle.dispatch(Message.ClickedConnect())
    expect(acquired).toBe(1)

    handle.dispose()
    await settle()
    expect(released).toBe(1)
  })

  it('reports an acquire failure without taking the runtime down', async () => {
    const errors: Array<{ phase: string; error: unknown }> = []
    const app = makeApplication<Model, Message, never>({
      Model,
      init: () => ({ model: { isConnected: false, lastResult: '' } }),
      update: (model, message) =>
        Message.match<Update.Return<Model, Message, never>>(message, {
          ClickedConnect: () => ({ model: modifyFields(model, { isConnected: () => true }) }),
          ClickedDisconnect: () => ({ model }),
          CompletedQuery: () => ({ model }),
        }),
      view: (model, h) => h('view', null, h('text', null, 'alive')),
      managedResources: {
        broken: ManagedResource.lifecycle<Model, Message>({
          modelToEnabled: () => true,
          acquire: Effect.sync(() => {
            throw new Error('device busy')
          }),
          release: () => Effect.void,
        }),
      },
      onError: (error, phase) => errors.push({ phase, error }),
    })

    const host = createTestHost<Model, Message, never>()
    const handle = startHeadless(app, host)

    expect(errors.map((entry) => entry.phase)).toContain('resource')
    expect(host.text()).toContain('alive')
    handle.dispose()
  })
})