/**
 * Types for the two modules the AI SDK's polyfills need, neither of which ships
 * declarations.
 *
 * `@ungap/structured-clone` and React Native's own `PolyfillFunctions` are both
 * untyped, and both are reached through dynamic imports at boot. Declaring the
 * shapes that are actually used - rather than casting to `any` at the call site -
 * means a rename upstream is a compile error here instead of an undefined at
 * runtime, which is exactly the failure mode a polyfill can least afford.
 *
 * Named `ambient.d.ts` rather than `polyfills.d.ts` on purpose: TypeScript pairs a
 * `.d.ts` with the `.ts` of the same name beside it and drops it from the program's
 * root files, so the declarations silently stopped applying and the errors they
 * were written to fix came back. A file that has to be a root cannot share a name.
 */

declare module '@ungap/structured-clone' {
  const structuredClone: <T>(value: T) => T
  export default structuredClone
}

declare module 'react-native/Libraries/Utilities/PolyfillFunctions' {
  /** Installs a global, but only if it is absent - which is what makes these safe to re-run. */
  export function polyfillGlobal(name: string, getValue: () => unknown): void
}
