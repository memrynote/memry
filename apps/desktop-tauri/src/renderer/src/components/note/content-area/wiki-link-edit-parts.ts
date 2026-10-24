/**
 * The pieces of the wiki-link edit plugin that do not need its state: how a
 * chip's marks become ProseMirror marks and back while it is raw text, and the
 * painted markdown shown beside the caret.
 */

import type { Mark, Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { wikiLinkToText } from './wiki-link'

/**
 * The chip's marks travel with it into the raw text and back.
 *
 * A wiki link carries its marks as PROPS (#1439 — BlockNote gives custom inline
 * content no `styles` field), while the raw text carries them as ProseMirror
 * marks, so the round trip has to translate. Every lookup is defensive: a mark
 * this schema does not have is simply not carried, never a throw inside a
 * keystroke handler.
 */
const BOOLEAN_MARKS = ['bold', 'italic', 'underline', 'strike', 'code'] as const
const COLOR_MARKS = ['textColor', 'backgroundColor'] as const

export function marksFromProps(schema: Schema, attrs: Record<string, unknown>): Mark[] {
  const marks: Mark[] = []

  for (const name of BOOLEAN_MARKS) {
    if (attrs[name] !== true) continue
    const type = schema.marks[name]
    if (type) marks.push(type.create())
  }

  for (const name of COLOR_MARKS) {
    const value = attrs[name]
    if (typeof value !== 'string' || value === '' || value === 'default') continue
    const type = schema.marks[name]
    if (type) marks.push(type.create({ stringValue: value }))
  }

  return marks
}

export function propsFromMarks(marks: readonly Mark[]): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = {}

  for (const mark of marks) {
    const name = mark.type.name
    if ((BOOLEAN_MARKS as readonly string[]).includes(name)) {
      props[name] = true
      continue
    }
    if ((COLOR_MARKS as readonly string[]).includes(name)) {
      const value = (mark.attrs as { stringValue?: unknown } | undefined)?.stringValue
      if (typeof value === 'string' && value !== '' && value !== 'default') props[name] = value
    }
  }

  return props
}

/** The chip's markdown, split so the brackets can be dimmed on their own. */
export function sourceTextOf(node: ProseMirrorNode): string {
  const target = typeof node.attrs.target === 'string' ? node.attrs.target : ''
  const alias = typeof node.attrs.alias === 'string' ? node.attrs.alias : ''
  return wikiLinkToText(target, alias)
}

export function renderSourceWidget(text: string): HTMLElement {
  const dom = document.createElement('span')
  dom.className = 'wiki-link-source'
  dom.setAttribute('data-wiki-link-source', '')

  const open = document.createElement('span')
  open.className = 'wiki-link-bracket'
  open.textContent = '[['

  const close = document.createElement('span')
  close.className = 'wiki-link-bracket'
  close.textContent = ']]'

  dom.append(open, document.createTextNode(text.slice(2, -2)), close)
  return dom
}
