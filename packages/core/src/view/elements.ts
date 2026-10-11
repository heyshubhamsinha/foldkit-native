/**
 * The native element vocabulary: what a view can name, and what it can listen to.
 *
 * The names are the engine's, lowercased and hyphenated, which is the same
 * spelling React Native uses and the one a `<view>` reads as. Every one of them
 * maps to a real Fabric component, so `text` is a `Paragraph` on iOS and
 * `text-input` is a `TextInput` - a `UIView` and an `android.widget.EditText` -
 * rather than a styled rectangle.
 *
 * Because every prop here is a native prop, the type in this file is the whole
 * documentation for what a platform can do. There is no DOM to guess from.
 */
import type { ElementVNode, FragmentVNode, TextVNode, VNodeChild } from './vnode.js'

/** Every element name the renderer knows. */
export type NativeElementName =
  // Structure
  | 'view'
  | 'text'
  | 'image'
  | 'scroll-view'
  | 'safe-area-view'
  | 'modal'
  | 'switch'
  | 'text-input'
  | 'activity-indicator'
  | 'refresh-control'
  | 'input-accessory-view'
  | 'pressable'
  | 'touchable-opacity'
  | 'image-background'
  | 'keyboard-avoiding-view'
  | 'virtual-list'
  // Layout and text, spelled as one would in the browser. Each is a plain view
  // or a paragraph, so a view can be structured the way it reads.
  | 'div'
  | 'section'
  | 'article'
  | 'header'
  | 'footer'
  | 'main'
  | 'nav'
  | 'ul'
  | 'ol'
  | 'li'
  | 'span'
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'label'
  | 'strong'
  | 'b'
  | 'em'
  | 'i'
  | 'u'
  | 's'
  | 'small'
  | 'code'
  | 'mark'
  | 'abbr'
  | 'cite'
  | 'time'

/** The name list at runtime, for validation and for DevTools. */
export const NATIVE_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  'view',
  'text',
  'image',
  'scroll-view',
  'safe-area-view',
  'modal',
  'switch',
  'text-input',
  'activity-indicator',
  'refresh-control',
  'input-accessory-view',
  'pressable',
  'touchable-opacity',
  'image-background',
  'keyboard-avoiding-view',
  'virtual-list',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'ul',
  'ol',
  'li',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'code',
  'mark',
  'abbr',
  'cite',
  'time',
])

/** Elements whose children are text, not layout. */
export const TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'text',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'code',
  'mark',
  'abbr',
  'cite',
  'time',
])

/** What a touch carries. The same shape every pressable event is given. */
export interface PressEvent {
  readonly pageX?: number
  readonly pageY?: number
  readonly locationX?: number
  readonly locationY?: number
  readonly identifier?: number
  readonly timestamp?: number
}

/** A node's frame after layout. */
export interface LayoutEvent {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ScrollEvent {
  readonly contentOffset?: { readonly x: number; readonly y: number }
  readonly contentSize?: { readonly width: number; readonly height: number }
  readonly layoutMeasurement?: { readonly width: number; readonly height: number }
}

export interface SizeEvent {
  readonly width: number
  readonly height: number
}

export interface SelectionEvent {
  readonly start: number
  readonly end: number
}

/** What every event handler is given. */
export type EventPayload =
  | PressEvent
  | LayoutEvent
  | ScrollEvent
  | SizeEvent
  | SelectionEvent
  | string
  | boolean
  | undefined

/**
 * An inline style. React Native's property names, which is what Fabric reads.
 *
 * Written as an object rather than a CSS string because there is no stylesheet
 * to parse at runtime here: this object goes straight to the native view. A
 * value of `undefined` or `null` clears the property, which is how a style says
 * "whatever the platform default is" - the same thing `null` means in React
 * Native, so a style composed from a conditional reads the way it does there.
 *
 * ```ts
 * const style = {
 *   flex: 1,
 *   padding: 16,
 *   backgroundColor: isActive ? '#3b6ef5' : '#e8eaed',
 *   borderRadius: 12,
 * }
 * ```
 */
/** A style value: a scalar, or a small object like `shadowOffset` or `transform`. */
export type StyleValue = string | number | undefined | null | false | { readonly [property: string]: unknown }

export interface Style {
  readonly [property: string]: StyleValue
}

/**
 * The props an element accepts.
 *
 * An event prop is a function returning a Message. It does not dispatch
 * anything itself and cannot: the only way a Message reaches the runtime is by
 * being returned from here, and the runtime puts it through `update` like any
 * other fact. So a tap and a network response are handled in the same place, by
 * the same exhaustive `match`.
 *
 * The name after `on` is the Fabric event's own name, uppercased: `onChange`
 * listens for `topChange`, `onLayout` for `topLayout`. `onPress` is the one
 * exception - it is synthesized from the engine's responder system, the way
 * React Native's own `Pressable` does it, so that a button and a scroll view
 * agree about who owns a drag.
 */
export interface NativeEventProps<Message> {
  /** A press began and ended on this element. */
  onPress?: (event: PressEvent) => Message
  /** A press held past the platform's threshold. */
  onLongPress?: (event: PressEvent) => Message
  /** A text input's text changed. */
  onChange?: (value: string) => Message
  /** A switch's value changed. */
  onValueChange?: (value: boolean) => Message
  onSubmitEditing?: (value: string) => Message
  onFocus?: (value: string | undefined) => Message
  onBlur?: (value: string | undefined) => Message
  onKeyPress?: (key: string) => Message
  onSelectionChange?: (selection: SelectionEvent) => Message
  onLayout?: (layout: LayoutEvent) => Message
  onScroll?: (event: ScrollEvent) => Message
  onContentSizeChange?: (size: SizeEvent) => Message
  onEndReached?: (event: ScrollEvent) => Message
  onRefresh?: () => Message
  onLoad?: () => Message
  onError?: (message: string) => Message
  onProgress?: (event: { loaded: number; total: number }) => Message
}

/** Props every element accepts. */
export interface CommonProps {
  /** Inline style, applied after the cascade. */
  readonly style?: Style
  /** Space-separated class names, matched against the app's stylesheet. */
  readonly class?: string
  /** Identity across renders, for keyed children. */
  readonly key?: string
  /** The name a test or an accessibility tool finds this element by. */
  readonly testID?: string
  /** What an assistive technology announces. */
  readonly accessibilityLabel?: string
  readonly accessibilityHint?: string
  readonly accessibilityRole?: string
  readonly accessibilityState?: {
    readonly disabled?: boolean
    readonly selected?: boolean
    readonly checked?: boolean
  }
  readonly accessible?: boolean
  /** `true` while the element is pressed, as `:active` is on the web. */
  readonly disabled?: boolean
}

/**
 * Every prop an element accepts: the common ones, the events, and any native
 * prop the engine forwards. The index signature is deliberate - the native views
 * behind these names have more props than any list here, and a platform module
 * can pass one the type does not name.
 */
export type NativeProps<Message> = CommonProps & NativeEventProps<Message> & {
  readonly [prop: string]: unknown
}

/**
 * The view builder a `view` function is given.
 *
 * Callable as `h('view', props, ...children)`, with `h.text` for a bare string
 * and `h.fragment` for several siblings where one is expected.
 */
export interface NativeBuilder<Message> {
  <Name extends NativeElementName>(
    name: Name,
    props?: NativeProps<Message> | null,
    ...children: ReadonlyArray<VNodeChild>
  ): ElementVNode
  readonly text: (value: string | number) => TextVNode
  readonly fragment: (...children: ReadonlyArray<VNodeChild>) => FragmentVNode
}

/**
 * The Fabric event name an `on<Name>` prop listens for.
 *
 * `onPress` is excluded: it is a responder, not a Fabric event, and the renderer
 * wires it through the engine's responder system instead.
 */
export const eventNameFor = (prop: string): string | undefined => {
  if (!prop.startsWith('on') || prop.length < 3) return undefined
  const name = prop[2]!
  if (name !== name.toUpperCase() && name !== name.toLowerCase()) return undefined
  return `top${name[0]!.toUpperCase()}${prop.slice(3)}`
}