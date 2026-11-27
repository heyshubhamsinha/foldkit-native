/**
 * Markdown, rendered as native elements.
 *
 * The original app hands its replies to `react-native-enriched-markdown`. There is
 * no such thing here, because there is no React tree to hand anything to - a
 * `view` is a function that returns plain data, so markdown has to be *parsed*
 * rather than delegated. This is that parser, and it returns the same nodes for
 * the same text every time, which is what makes it testable: a Scene can assert
 * that a reply produced a heading and a code block without rendering anything.
 *
 * The subset is deliberately small - headings, paragraphs, bullet and numbered
 * lists, fenced code, and the four inline spans. It covers what a chat reply
 * actually contains, and every construct it does not support falls through as
 * literal text rather than being dropped, so an unsupported mark shows up as the
 * character the user wrote instead of silently vanishing.
 */

import type { NativeViewBuilder, VNode, VNodeChild } from '@foldkit-native/core'
import { ChatMessageUnion, type ChatMessage } from './model'

/** One block of the document. Parsed first, then turned into nodes. */
type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'bullet'; readonly items: ReadonlyArray<string> }
  | { readonly kind: 'numbered'; readonly items: ReadonlyArray<string> }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }

const FENCE = /^```(\w*)\s*$/

/** Splits the source into blocks. Line-ending agnostic, because a reply may arrive with either. */
export const parseBlocks = (source: string): ReadonlyArray<Block> => {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const language = fence[1] ?? ''
      const body: string[] = []
      index += 1
      // An unterminated fence runs to the end of the message rather than
      // swallowing the rest of the conversation - a reply cut off mid-block is
      // still worth reading.
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({ kind: 'code', language, text: body.join('\n') })
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: Math.min(heading[1]?.length ?? 1, 3) as 1 | 2 | 3,
        text: heading[2] ?? '',
      })
      index += 1
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*]\s+/, ''))
        index += 1
      }
      blocks.push({ kind: 'bullet', items })
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+\.\s+/, ''))
        index += 1
      }
      blocks.push({ kind: 'numbered', items })
      continue
    }

    if (line.trim() === '') {
      index += 1
      continue
    }

    // A paragraph runs to the next blank line *or* the next block starter, so a
    // reply that puts a list straight after a sentence does not swallow it.
    const paragraph: string[] = []
    while (index < lines.length) {
      const next = lines[index] ?? ''
      if (next.trim() === '' || FENCE.test(next) || /^#{1,3}\s/.test(next) || /^\s*[-*]\s+/.test(next) || /^\s*\d+\.\s+/.test(next)) {
        break
      }
      paragraph.push(next)
      index += 1
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
  }

  return blocks
}

/** Bold, italic, code and links, in that order of precedence. */
const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g

type Span =
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'italic'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly url: string }
  | { readonly kind: 'plain'; readonly text: string }

/** Exported for tests: the spans a line of text breaks into. */
export const parseSpans = (text: string): ReadonlyArray<Span> => {
  const spans: Span[] = []
  let last = 0

  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > last) spans.push({ kind: 'plain', text: text.slice(last, start) })
    const token = match[0]

    if (token.startsWith('**') || token.startsWith('__')) {
      spans.push({ kind: 'bold', text: token.slice(2, -2) })
    } else if (token.startsWith('`')) {
      spans.push({ kind: 'code', text: token.slice(1, -1) })
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      spans.push({ kind: 'link', text: token.slice(1, split), url: token.slice(split + 2, -1) })
    } else {
      spans.push({ kind: 'italic', text: token.slice(1, -1) })
    }
    last = start + token.length
  }

  if (last < text.length) spans.push({ kind: 'plain', text: text.slice(last) })
  return spans
}

const styles = {
  heading: { color: '#ffffff', fontWeight: '700' as const, marginTop: 14, marginBottom: 4 },
  paragraph: { color: '#e6eaef', fontSize: 16, lineHeight: 23 },
  listItem: { color: '#e6eaef', fontSize: 16, lineHeight: 23 },
  bullet: { color: '#7d8894', fontSize: 16, lineHeight: 23, width: 18 },
  code: { color: '#8fd6c0', backgroundColor: '#1b2229', fontSize: 14, fontFamily: 'Menlo' },
  link: { color: '#5aa2ff', textDecorationLine: 'underline' as const },
} as const

/**
 * Renders one line of text.
 *
 * A link is a `pressable` rather than a styled span because it is the one thing in
 * a reply that does something, and a tap that returns a Message is the only way
 * this framework lets a tap do anything at all.
 */
const renderSpans = (text: string, h: NativeViewBuilder<ChatMessage>): VNodeChild[] =>
  parseSpans(text).map((span) => {
    switch (span.kind) {
      case 'bold':
        return h('text', { style: { color: '#ffffff', fontWeight: '700' } }, span.text)
      case 'italic':
        return h('text', { style: { color: '#e6eaef', fontStyle: 'italic' } }, span.text)
      case 'code':
        return h('text', { style: styles.code }, span.text)
      case 'link':
        return h(
          'text',
          {
            style: styles.link,
            accessibilityRole: 'link',
            accessibilityLabel: `Open ${span.text}`,
            onPress: () => ChatMessageUnion.ClickedLink({ url: span.url }),
          },
          span.text,
        )
      case 'plain':
        return h('text', { style: styles.paragraph }, span.text)
    }
  })

/**
 * Renders a whole reply.
 *
 * Returns an array rather than one node because a reply is a *sequence* of blocks,
 * and the caller puts them where it wants them - inside a bubble, inside a sheet,
 * or on their own.
 */
export const markdown = (source: string, h: NativeViewBuilder<ChatMessage>): VNode[] =>
  parseBlocks(source).map((block) => {
    switch (block.kind) {
      case 'heading':
        return h(
          'text',
          { style: { ...styles.heading, fontSize: block.level === 1 ? 24 : block.level === 2 ? 20 : 17 }, testID: `md-h${block.level}` },
          ...renderSpans(block.text, h),
        )

      case 'paragraph':
        return h('text', { style: styles.paragraph }, ...renderSpans(block.text, h))

      case 'bullet':
        return h(
          'view',
          { style: { marginTop: 4 } },
          ...block.items.flatMap((item) => [
            h(
              'view',
              { key: item, style: { flexDirection: 'row', marginBottom: 4 } },
              h('text', { style: styles.bullet }, '•'),
              h('text', { style: styles.listItem }, ...renderSpans(item, h)),
            ),
          ]),
        )

      case 'numbered':
        return h(
          'view',
          { style: { marginTop: 4 } },
          ...block.items.flatMap((item, index) => [
            h(
              'view',
              { key: item, style: { flexDirection: 'row', marginBottom: 4 } },
              h('text', { style: styles.bullet }, `${index + 1}.`),
              h('text', { style: styles.listItem }, ...renderSpans(item, h)),
            ),
          ]),
        )

      case 'code':
        return h(
          'view',
          { style: { backgroundColor: '#1b2229', borderRadius: 10, padding: 12, marginVertical: 6 } },
          // The language is shown because a fence without one is indistinguishable
          // from a block of prose once it is a grey rectangle.
          block.language === ''
            ? null
            : h('text', { style: { color: '#6b7683', fontSize: 12, marginBottom: 6 } }, block.language),
          h('text', { style: styles.code, testID: 'md-code' }, block.text),
        )
    }
  })
