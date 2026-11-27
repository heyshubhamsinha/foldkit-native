/**
 * The polyfills the Vercel AI SDK needs in a React Native runtime.
 *
 * `streamText` is a `ReadableStream`, and the runtime does not have one. Metro only
 * installs the polyfills this package brings when something imports it, so
 * `main.ts` imports this file first - before `expo`, before `@foldkit-native/core`,
 * before anything that could reach for a stream.
 *
 * The guards are the ones the AI SDK's own guidance uses, because in Expo several
 * of these already exist and installing a second one is how a working app breaks.
 */

import { Platform } from 'react-native'
import structuredClone from '@ungap/structured-clone'

if (Platform.OS !== 'web') {
  const setup = async (): Promise<void> => {
    const { polyfillGlobal } = await import('react-native/Libraries/Utilities/PolyfillFunctions')
    const { TextEncoderStream, TextDecoderStream } = await import('@stardazed/streams-text-encoding')

    if (!('structuredClone' in global)) {
      polyfillGlobal('structuredClone', () => structuredClone)
    }

    polyfillGlobal('TextEncoderStream', () => TextEncoderStream)
    polyfillGlobal('TextDecoderStream', () => TextDecoderStream)
  }

  // Deliberately not awaited: this file must not block the boot sequence, and
  // every one of these is looked up lazily by the time `streamText` runs.
  void setup()
}

export {}
