/**
 * Immutable field updates for the Model.
 *
 * The Elm Architecture has one rule that makes everything else possible: state
 * changes by producing a new Model, never by mutating the old one. Doing that by
 * hand means either a spread on every line of `update` or a copy of the Model's
 * shape at every call site, and both get the types wrong the first time a field
 * is renamed.
 *
 * `modifyFields` is the one call that says "a new Model, with these fields
 * replaced". Every field you name is computed from its current value, every
 * field you do not name is carried over, and the result keeps the Model's type.
 */

/** Each transformer receives its field's current value and returns the next one. */
export type EvolveTransform<O> = {
  [K in keyof O]?: (value: O[K]) => O[K]
}

/**
 * Rejects a key the Model does not have.
 *
 * A misspelled field in `modifyFields` is otherwise invisible: the spread drops
 * it and the Model quietly keeps its old value, so the feature is simply
 * missing. Naming the bad key in the error type turns that into a compile
 * error next to the line that caused it.
 */
export type StrictKeys<O, T> = Exclude<Extract<keyof T, string>, keyof O & string> extends never
  ? T
  : T & { readonly [K in `Invalid key: ${Exclude<Extract<keyof T, string>, keyof O & string>}`]: never }

/** The Model after the transforms: a named field takes the transform's result, the rest carry over. */
export type Evolved<O, T> = {
  [K in keyof O]: K extends keyof T ? (T[K] extends (value: never) => infer R ? R : O[K]) : O[K]
}

const apply = <O, T extends EvolveTransform<O>>(obj: O, transforms: T): Evolved<O, T> => {
  // One shallow copy, then assign. A Model is a flat record of primitives and
  // nested immutable values, so this is the whole of the immutability the
  // architecture asks for and nothing more is copied.
  const out = { ...obj } as Record<string, unknown>
  for (const key of Object.keys(transforms) as Array<keyof O & string>) {
    const transform = transforms[key] as ((value: unknown) => unknown) | undefined
    if (transform === undefined) continue
    out[key] = transform((obj as Record<string, unknown>)[key])
  }
  return out as Evolved<O, T>
}

/**
 * A new Model with the named fields replaced.
 *
 * A transformer takes the field's current value and returns its next one, so a
 * change never reads the Model it is changing:
 *
 * ```ts
 * modifyFields(model, { count: count => count + 1 })
 * ```
 *
 * Write `() => value` when the new value does not come from the old one. That is
 * the same function, so the two styles read alike:
 *
 * ```ts
 * modifyFields(model, { isResetting: () => true, count: () => 0 })
 * ```
 *
 * Every field not named is carried over, and the result keeps the Model's exact
 * type, so a field renamed in the Schema fails here rather than being dropped.
 *
 * ```ts
 * import { modifyFields } from 'foldkit-native/struct'
 *
 * type UpdateReturn = Update.Return<Model, Message>
 * const update = (model: Model, message: Message) =>
 *   Message.match<UpdateReturn>(message, {
 *     ClickedIncrement: () => ({ model: modifyFields(model, { count: count => count + 1 }) }),
 *     ChangedResetDuration: ({ seconds }) => ({
 *       model: modifyFields(model, { resetDuration: () => seconds }),
 *     }),
 *   })
 * ```
 */
export const modifyFields: (<O, const T extends EvolveTransform<O>>(
  obj: O,
  transforms: StrictKeys<O, T>,
) => Evolved<O, T>) &
  (<O, const T extends EvolveTransform<O>>(transforms: StrictKeys<O, T>) => (obj: O) => Evolved<O, T>) = Object.assign(
  <O, const T extends EvolveTransform<O>>(obj: O, transforms: StrictKeys<O, T>): Evolved<O, T> =>
    apply(obj, transforms as unknown as T),
  <O, const T extends EvolveTransform<O>>(transforms: StrictKeys<O, T>) => (obj: O): Evolved<O, T> =>
    apply(obj, transforms as unknown as T),
) as any

/**
 * A `modifyFields` bound to a base shape, for a helper whose Model extends it.
 *
 * ```ts
 * const modifyCount = makeModifyFieldsFor<{ count: number }>()
 *
 * // In a helper that works for any Model with a count:
 * modifyCount(model, { count: count => count + 1 })
 * ```
 *
 * The returned function keeps the Model's own subtype, so a helper written once
 * still returns the full Model rather than the base shape it was checked
 * against.
 */
export const makeModifyFieldsFor =
  <Base extends Record<string, unknown>>() =>
  <Model extends Base>(model: Model, transforms: EvolveTransform<Base>): Model =>
    apply(model as Base, transforms) as Model