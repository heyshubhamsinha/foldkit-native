/**
 * `Message`: the one place a Message union is declared.
 *
 * A thin module over `schema.ts`, kept separate so an application can import
 * `defineMessageUnion` from `'foldkit-native/message'` without pulling in the
 * renderer, the runtime and the platform host. A large application has a lot of
 * modules that only need the Message union, and none of them needs Fabric.
 */
export { defineMessageUnion, defineTaggedUnion, taggedStruct, ReservedTagError } from './schema.js'
export type { CallableTaggedStruct, TaggedUnion, TaggedUnionType, Variant } from './schema.js'