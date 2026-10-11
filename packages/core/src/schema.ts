import { Schema } from 'effect'

/**
 * The tagged-union layer every other part of Foldkit Native is written against.
 *
 * A union is declared once, in one object, and the result is both a Schema and a
 * namespace. `Schema.TaggedUnion` supplies the Schema and the exhaustive `match`
 * that keeps every fact handled; this module adds the two things a union needs
 * to be pleasant to write every day - one callable constructor per variant, so
 * `Message.ChangedCount({ count: 1 })` builds a value without reaching for
 * `.make` - and the helpers that keep variant lists explicit.
 *
 * Nothing here knows about native views. A Message is a fact, and a fact is the
 * same on every platform, which is what lets the runtime, the tests and the
 * renderer share one declaration.
 */

/**
 * Names the union itself owns. A variant tag may not be one of them, because
 * `Message.match` and `Message.ClickedIncrement` would then be the same
 * property. TypeScript rejects these names; the runtime throws.
 */
const RESERVED_TAGS: ReadonlySet<string> = new Set([
  'ast',
  'cases',
  'guards',
  'isAnyOf',
  'make',
  'match',
  'matchOrElse',
  'members',
  'subset',
  'tag',
])

/** The tags a union owns, which a variant may not reuse. */
type ReservedTag = 'ast' | 'cases' | 'guards' | 'isAnyOf' | 'make' | 'match' | 'matchOrElse' | 'members' | 'subset' | 'tag'

/** The error `defineUnion` throws for a tag the union already uses. */
export class ReservedTagError extends Error {
  readonly _tag = 'ReservedTagError'
  constructor(readonly tag: string) {
    super(`'${tag}' is already a property of a tagged union. Rename the variant.`)
    this.name = 'ReservedTagError'
  }
}

/** A `TaggedStruct` schema that is also callable: `Foo({ n: 1 })`, not `Foo.make({ n: 1 })`. */
export type CallableTaggedStruct<Tag extends string, Fields extends Schema.Struct.Fields> =
  Schema.TaggedStruct<Tag, Fields> & MakeIn<Schema.Schema.Type<Schema.TaggedStruct<Tag, Fields>>>

/**
 * The call signature a variant gets. A variant with no fields is constructed
 * with no argument at all, which is the common case for a fact that only names
 * itself: `Message.ClickedReset()`, not `Message.ClickedReset({})`.
 */
type MakeIn<Value> = [Exclude<keyof Value, '_tag'>] extends [never]
  ? (value?: void) => Value
  : (value: Omit<Value, '_tag'>) => Value

/** One variant's value type. */
export type Variant<CasesByTag extends Record<string, Schema.Struct.Fields>, Tag extends keyof CasesByTag & string> =
  Schema.Schema.Type<Schema.TaggedStruct<Tag, CasesByTag[Tag]>>

/** The union's value type: every variant, discriminated by `_tag`. */
export type TaggedUnionType<CasesByTag extends Record<string, Schema.Struct.Fields>> = {
  [Tag in keyof CasesByTag & string]: Variant<CasesByTag, Tag>
}[keyof CasesByTag & string]

/** One guard per variant, for narrowing an `unknown` in an `if`. */
export type TaggedUnionGuards<CasesByTag extends Record<string, Schema.Struct.Fields>> = {
  -readonly [Tag in keyof CasesByTag & string]: (value: unknown) => value is Variant<CasesByTag, Tag>
}

/** Exhaustive `match`: every variant must be handled, and nothing else may be. */
export type TaggedUnionMatch<CasesByTag extends Record<string, Schema.Struct.Fields>, Output> = {
  readonly [Tag in keyof CasesByTag & string]: (value: Variant<CasesByTag, Tag>) => Output
}

/** `matchOrElse`: a subset of variants, with a fallback for the rest. */
export type TaggedUnionMatchOrElse<CasesByTag extends Record<string, Schema.Struct.Fields>, Output> = {
  readonly [Tag in keyof CasesByTag & string]?: (value: Variant<CasesByTag, Tag>) => Output
}

/**
 * Rejects a case object naming a variant that does not exist.
 *
 * A misspelled tag in an `update` arm is the one mistake this architecture
 * cannot afford, because the arm still typechecks and the fact silently falls
 * through the whole runtime.
 */
export type ValidateCases<CasesByTag extends Record<string, Schema.Struct.Fields>, Cases> = Exclude<
  Extract<keyof Cases, string>,
  keyof CasesByTag & string
> extends never
  ? unknown
  : Readonly<{ 'Every case must name a declared variant': Exclude<Extract<keyof Cases, string>, keyof CasesByTag & string> }>

/** Rejects a variant tag that would collide with a property the union owns. */
export type ValidateVariantNames<CasesByTag extends Record<string, Schema.Struct.Fields>> = Extract<keyof CasesByTag, ReservedTag> extends never
  ? unknown
  : Readonly<{ 'Variant names must not conflict with union properties': Extract<keyof CasesByTag, ReservedTag> }>

/** One callable constructor per variant, as a namespace. */
type VariantNamespace<CasesByTag extends Record<string, Schema.Struct.Fields>> = {
  readonly [Tag in keyof CasesByTag & string]: CallableTaggedStruct<Tag, CasesByTag[Tag]>
}

/**
 * The union: a Schema, a namespace of constructors, and the matching helpers.
 *
 * `Type` is the value type, which is what an application writes as its `Message`.
 */
export type TaggedUnion<CasesByTag extends Record<string, Schema.Struct.Fields>> = VariantNamespace<CasesByTag> & {
  readonly Type: TaggedUnionType<CasesByTag>
  readonly ast: Schema.TaggedUnion<{
    readonly [Tag in keyof CasesByTag & string]: Schema.TaggedStruct<Tag, CasesByTag[Tag]>
  }>['ast']
  readonly guards: TaggedUnionGuards<CasesByTag>
  readonly match: <
    Output,
    const Cases extends TaggedUnionMatch<CasesByTag, Output> = TaggedUnionMatch<CasesByTag, Output>,
  >(
    value: TaggedUnionType<CasesByTag>,
    cases: Cases & ValidateCases<CasesByTag, Cases>,
  ) => Output
  readonly matchOrElse: <Output>(
    value: TaggedUnionType<CasesByTag>,
    cases: TaggedUnionMatchOrElse<CasesByTag, Output>,
    orElse: (value: TaggedUnionType<CasesByTag>) => Output,
  ) => Output
  readonly isAnyOf: <const Tags extends ReadonlyArray<keyof CasesByTag & string>>(
    ...tags: Tags
  ) => (value: unknown) => value is Extract<TaggedUnionType<CasesByTag>, { readonly _tag: Tags[number] }>
  /** Every variant tag, in declaration order. For APIs that enumerate a union. */
  readonly members: ReadonlyArray<keyof CasesByTag & string>
  /** A Schema accepting only the named variants, for a boundary that should reject the rest. */
  readonly subset: <const Tags extends ReadonlyArray<keyof CasesByTag & string>>(...tags: Tags) => Schema.Top
}

/** The callable constructor for one variant. */
const constructorFor = <Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
): CallableTaggedStruct<Tag, Fields> => {
  const schema = Schema.TaggedStruct(tag, fields)
  const make = schema.make.bind(schema)
  // Effect's `make` rejects a missing argument even for a variant with no
  // fields, so `undefined` becomes `{}` here. That is what lets a fact that
  // only names itself be written `Message.ClickedIncrement()` rather than
  // `Message.ClickedIncrement({})` - the second one reads as though it had
  // fields, and there is nothing to put in them.
  const construct = (value?: unknown): unknown => make((value ?? {}) as never)
  return Object.assign(construct, schema) as CallableTaggedStruct<Tag, Fields>
}

const defineUnion = <CasesByTag extends Record<string, Schema.Struct.Fields>>(casesByTag: CasesByTag): TaggedUnion<CasesByTag> => {
  for (const tag of Object.keys(casesByTag)) {
    if (RESERVED_TAGS.has(tag)) throw new ReservedTagError(tag)
  }

  const base = Schema.TaggedUnion(casesByTag) as unknown as TaggedUnion<CasesByTag>
  const tags = Object.keys(casesByTag) as Array<keyof CasesByTag & string>

  const guards = {} as TaggedUnionGuards<CasesByTag>
  for (const tag of tags) {
    const specific = tag as unknown as keyof CasesByTag & string
    guards[specific] = (value: unknown): value is Variant<CasesByTag, typeof specific> =>
      typeof value === 'object' && value !== null && (value as { _tag?: unknown })._tag === tag
  }

  // The Schema's own `tag`, `cases`, `match`, `matchOrElse`, `guards` and
  // `isAnyOf` stay: they already do the right thing. What is added here is the
  // per-variant namespace, the variant list, and the subset helper.
  for (const tag of tags) {
    ;(base as Record<string, unknown>)[tag] = constructorFor(tag, casesByTag[tag]!)
  }

  ;(base as { guards: unknown }).guards = guards
  ;(base as { members: unknown }).members = Object.freeze([...tags]) as ReadonlyArray<keyof CasesByTag & string>
  ;(base as { isAnyOf: unknown }).isAnyOf = ((...names: ReadonlyArray<string>) => {
    const wanted = new Set<string>(names)
    return (value: unknown): boolean =>
      typeof value === 'object' && value !== null && wanted.has((value as { _tag?: unknown })._tag as string)
  }) as TaggedUnion<CasesByTag>['isAnyOf']
  ;(base as { subset: unknown }).subset = ((...names: ReadonlyArray<string>) => {
    const picked: Record<string, Schema.Struct.Fields> = {}
    for (const tag of names) picked[tag] = casesByTag[tag]!
    return Schema.TaggedUnion(picked) as unknown as Schema.Top
  }) as TaggedUnion<CasesByTag>['subset']

  return base
}

/**
 * Declares every variant of a domain union in one object. Use it for Model
 * states, submission results and filter modes - anything that is not a Message.
 *
 * ```ts
 * export const Submission = defineTaggedUnion({
 *   NotSubmitted: {},
 *   Submitting: {},
 *   Failed: { error: Schema.String },
 * })
 * export type Submission = typeof Submission.Type
 *
 * Submission.NotSubmitted()
 * Submission.Failed({ error: 'timeout' })
 * Submission.match(submission, { NotSubmitted: () => ..., Submitting: () => ..., Failed: () => ... })
 * ```
 */
export const defineTaggedUnion = defineUnion as <CasesByTag extends Record<string, Schema.Struct.Fields>>(
  casesByTag: CasesByTag & ValidateVariantNames<CasesByTag>,
) => TaggedUnion<CasesByTag>

/**
 * Declares an application's or a Submodel's Messages in one object.
 *
 * Messages are facts, named for what happened rather than for what should happen
 * next: `ClickedIncrement`, `SucceededFetchWeather`, not `Increment` and
 * `FetchWeather`. The runtime treats every fact identically, so the naming is for
 * the reader - and it is what makes an exhaustive `match` in `update` read like
 * the list of things that can happen.
 *
 * ```ts
 * export const Message = defineMessageUnion({
 *   ClickedIncrement: {},
 *   ChangedCount: { count: Schema.Number },
 * })
 * export type Message = typeof Message.Type
 *
 * Message.ClickedIncrement()
 * Message.ChangedCount({ count: 1 })
 * ```
 */
export const defineMessageUnion = defineUnion as <CasesByTag extends Record<string, Schema.Struct.Fields>>(
  casesByTag: CasesByTag & ValidateVariantNames<CasesByTag>,
) => TaggedUnion<CasesByTag>

/** A standalone tagged struct, for a value whose variants are declared apart. */
export const taggedStruct = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
): CallableTaggedStruct<Tag, Fields> => constructorFor(tag, fields)