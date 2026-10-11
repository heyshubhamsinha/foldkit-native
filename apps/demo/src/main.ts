/**
 * The entry point.
 *
 * Registered as an AppRegistry *runnable*, not a React component - and that one
 * choice is the whole bootstrap.
 *
 * `AppRegistry.registerRunnable('main', runnable)` hands this file the `rootTag`
 * and asks for nothing back. There is no React tree, so React never commits to
 * that root and never clears it. `registerRootComponent` - the obvious way to do
 * this, and what a first attempt reaches for - mounts a React component into the
 * same root, and React commits an *empty* child set for any component that
 * renders `null`. One root, two writers: the engine commits its tree, React's
 * commit lands after and erases it, and the screen is blank with nothing logged,
 * because nothing threw.
 *
 * This was not a bug that could be patched. It was the wrong entry point, and
 * the symptom it produced - "the tree commits, nothing draws" - looks exactly
 * like a dozen real ones.
 *
 * `expo` is imported for its runtime, not for a component: Metro only runs its
 * fetch, URL, TextDecoderStream and structuredClone polyfills when something
 * imports it, and in a release build nothing else does.
 */

import 'expo'
import { AppRegistry, Appearance, Dimensions, Image, PixelRatio, Platform, processColor } from 'react-native'
import { Layer, ManagedRuntime } from 'effect'
import { mountNative, mountNativeProgram } from '@foldkit-native/core/platform'
import { app } from './app'

/** What media queries resolve against, and what the engine sizes the viewport from. */
const conditions = (): { width: number; height: number; fontScale: number; colorScheme: 'light' | 'dark' } => {
  const { width, height, fontScale } = Dimensions.get('window')
  return { width, height, fontScale, colorScheme: Appearance.getColorScheme() === 'dark' ? 'dark' : 'light' }
}

let stop: (() => void) | null = null

AppRegistry.registerRunnable('main', ({ rootTag }) => {
  const tag = Number(rootTag)

  const surface = mountNative({
    rootTag: tag,
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    dev: typeof __DEV__ !== 'undefined' && __DEV__,
    conditions: conditions(),
    // Colours as the integers the platform wants. Without it a `*color` prop
    // reaches native as the string it was written as.
    processColor,
    // Local images come from `require('./x.png')`, which compiles to an asset
    // *id*; only this turns it into `{uri, width, height, scale}`. Remote
    // `{uri}` objects pass through and appear to prove the prop is fine.
    resolveAssetSource: (value) => Image.resolveAssetSource(value as never),
    // The hairline width, which is a third of a point on a 3x screen. Without
    // it `1px` is a whole point, which is a visibly fat divider.
    tokens: { '--hairline-width': { kind: 'hairline' as const, value: 1 / PixelRatio.get() } },
  })

  const handle = mountNativeProgram(app, surface, ManagedRuntime.make(Layer.empty), {
    onError: (error, context) => {
      // A failure inside a view or a handler must not take the app down: the
      // runtime catches it and the screen keeps whatever was last drawn, which
      // is a far better failure mode than a white screen.
      console.error(`[todo] ${context} failed`, error)
    },
  })

  const report = (): void => {
    if (typeof __DEV__ === 'undefined' || !__DEV__) return
    const { createdNodes, commits } = surface.engine.stats
    console.log(`[todo] running — rootTag=${tag} · ${createdNodes} native nodes · ${commits} commit(s)`)
  }
  report()

  // A rotation or a theme switch changes no node, so nothing marks the tree
  // dirty and no commit would follow - which is why `dark:` needs telling.
  const rotation = Dimensions.addEventListener('change', () => surface.engine.updateConditions(conditions()))
  const theme = Appearance.addChangeListener(() => surface.engine.updateConditions(conditions()))

  stop = () => {
    rotation.remove()
    theme.remove()
    handle.dispose()
  }
})

export const dispose = (): void => {
  stop?.()
  stop = null
}