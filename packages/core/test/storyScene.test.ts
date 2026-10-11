import { describe, expect, it } from 'vitest'
import { Effect, Schema } from 'effect'
import { Command, Scene, Story, Update, defineMessageUnion, modifyFields } from '../src/index.js'
import type { NativeViewBuilder } from '../src/view/submodel.js'
import type { VNode } from '../src/view/vnode.js'

const Model = Schema.Struct({
  zipCode: Schema.String,
  status: Schema.String,
  forecast: Schema.String,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ChangedZipCode: { zipCode: Schema.String },
  SubmittedWeatherForm: {},
  SucceededFetchWeather: { forecast: Schema.String },
})
type Message = typeof Message.Type

const FetchWeather = Command.define('FetchWeather', {
  args: { zipCode: Schema.String },
  messages: [Message.SucceededFetchWeather],
  execute: ({ zipCode }) => Effect.succeed(Message.SucceededFetchWeather({ forecast: `sunny in ${zipCode}` })),
})

const start: Model = { zipCode: '', status: 'Idle', forecast: '' }

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedZipCode: ({ zipCode }) => ({ model: modifyFields(model, { zipCode: () => zipCode }) }),
    SubmittedWeatherForm: () => ({
      model: modifyFields(model, { status: () => 'Loading' }),
      commands: [FetchWeather({ zipCode: model.zipCode })],
    }),
    SucceededFetchWeather: ({ forecast }) => ({ model: modifyFields(model, { status: () => 'Idle', forecast: () => forecast }) }),
  })

const view = (model: Model, h: NativeViewBuilder<Message>): VNode =>
  h(
    'view',
    { testID: 'screen' },
    h('text-input', {
      accessibilityLabel: 'Zip code',
      accessibilityRole: 'text',
      value: model.zipCode,
      onChange: (zipCode) => Message.ChangedZipCode({ zipCode }),
    }),
    h(
      'pressable',
      {
        accessibilityRole: 'button',
        accessibilityLabel: 'Get Weather',
        onPress: () => Message.SubmittedWeatherForm(),
      },
      h('text', null, model.status === 'Loading' ? 'Loading...' : 'Get Weather'),
    ),
    model.forecast === '' ? null : h('text', null, model.forecast),
  )

describe('a Story', () => {
  it('walks a transition sequence through the pure update', () => {
    Story.story(
      update,
      Story.given(start),
      Story.message(Message.ChangedZipCode({ zipCode: '90210' })),
      Story.model((model) => expect(model.zipCode).toBe('90210')),
      Story.message(Message.SubmittedWeatherForm()),
      Story.model((model) => expect(model.status).toBe('Loading')),
      Story.Command.expect(FetchWeather),
      Story.Command.resolve(FetchWeather, Message.SucceededFetchWeather({ forecast: '72F' })),
      Story.model((model) => {
        expect(model.status).toBe('Idle')
        expect(model.forecast).toBe('72F')
      }),
    )
  })

  it('never runs the Command Effect, so a slow world costs nothing', () => {
    const Slow = Command.define('Slow', {
      messages: [Message.SucceededFetchWeather],
      execute: Effect.as(Effect.sleep('30 seconds'), Message.SucceededFetchWeather({ forecast: 'never' })),
    })

    const slowUpdate = (model: Model, message: Message): Update.Return<Model, Message> =>
      Message.match<Update.Return<Model, Message>>(message, {
        ChangedZipCode: () => ({ model }),
        SubmittedWeatherForm: () => ({ model, commands: [Slow()] }),
        SucceededFetchWeather: ({ forecast }) => ({ model: modifyFields(model, { forecast: () => forecast }) }),
      })

    // No clock waited, no network stubbed, no timeout: the Story asserts the
    // transition and resolves the world itself.
    Story.story(
      slowUpdate,
      Story.given(start),
      Story.message(Message.SubmittedWeatherForm()),
      Story.Command.expect(Slow),
      Story.Command.resolve(Slow, Message.SucceededFetchWeather({ forecast: 'instant' })),
      Story.model((model) => expect(model.forecast).toBe('instant')),
      Story.Command.expectNone,
    )
  })

  it('fails when a Command was requested that the test did not expect', () => {
    expect(() =>
      Story.story(
        update,
        Story.given(start),
        Story.message(Message.ChangedZipCode({ zipCode: '90210' })),
        Story.Command.expect(FetchWeather),
      ),
    ).toThrow(/FetchWeather/)
  })

  it('fails when nothing is left in flight but something is', () => {
    expect(() =>
      Story.story(
        update,
        Story.given(start),
        Story.message(Message.SubmittedWeatherForm()),
        Story.Command.expectNone,
      ),
    ).toThrow(/in flight/)
  })

  it('records the Messages in order, which is what a trace shows', () => {
    const final = Story.story(
      update,
      Story.given(start),
      Story.message(Message.ChangedZipCode({ zipCode: '90210' })),
      Story.message(Message.SubmittedWeatherForm()),
    )

    expect(final.log.map((message) => message._tag)).toEqual(['ChangedZipCode', 'SubmittedWeatherForm'])
  })
})

describe('a Scene', () => {
  it('drives the real view through accessible locators', () => {
    Scene.scene(
      { update, view },
      Scene.given(start),
      Scene.type(Scene.label('Zip code'), '90210'),
      Scene.model((model) => expect(model.zipCode).toBe('90210')),
      Scene.click(Scene.role('button', { name: 'Get Weather' })),
      Scene.expectText('Loading...'),
      Scene.Command.expect(FetchWeather),
      Scene.Command.resolve(FetchWeather, Message.SucceededFetchWeather({ forecast: 'Beverly Hills, 72F' })),
      Scene.expectText('Beverly Hills, 72F'),
    )
  })

  it('reads the screen the way an accessibility tool would', () => {
    Scene.scene({ update, view }, Scene.given(start), Scene.expect(Scene.label('Zip code')), Scene.expect(Scene.role('button')))
  })

  it('fails when the view stopped drawing what it used to', () => {
    expect(() =>
      Scene.scene({ update, view }, Scene.given(start), Scene.expect(Scene.label('Conditions'))),
    ).toThrow(/Conditions/)
  })

  it('asserts that something is gone', () => {
    expect(() =>
      Scene.scene({ update, view }, Scene.given(start), Scene.expectNot(Scene.label('Zip code'))),
    ).toThrow(/nothing matching/)
  })

  it('fails when a step interacts with an element that has no such handler', () => {
    expect(() => Scene.scene({ update, view }, Scene.given(start), Scene.click(Scene.label('Zip code')))).toThrow(/onPress/)
  })

  it('renders a conditional as absent rather than as empty', () => {
    Scene.scene({ update, view }, Scene.given(start), Scene.expectNot(Scene.text('Beverly Hills, 72F')))
  })

  it('fails when a Command is resolved that was never requested', () => {
    expect(() =>
      Scene.scene({ update, view }, Scene.given(start), Scene.Command.resolve(FetchWeather, Message.SucceededFetchWeather({ forecast: 'x' }))),
    ).toThrow(/never requested/)
  })
})