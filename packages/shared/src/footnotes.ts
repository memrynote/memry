import { maskMarkdownCode } from './markdown-code.ts'

/**
 * Footnotes stay plain markdown in the file (BBF-24): `[^label]` in the text,
 * `[^label]: text` on its own line. This scan is what the editor markers and
 * the exports read, so both number a note the same way.
 */
export interface FootnoteReference {
  label: string
  /** 1-based, in the order of each note's first reference. */
  number: number
  start: number
  end: number
}

export interface FootnoteDefinition {
  label: string
  /** Null for a definition nothing references, or a repeat of an earlier label. */
  number: number | null
  /** From the `[^` to the end of its last line, line break excluded. */
  start: number
  end: number
  /** The body without its marker, continuation lines dedented. */
  text: string
}

export interface Footnotes {
  references: FootnoteReference[]
  definitions: FootnoteDefinition[]
}

const DEFINITION_LINE = /^( {0,3})\[\^([^\s[\]]+)\]:[ \t]*/
const REFERENCE = /\[\^([^\s[\]]+)\]/g
const CONTINUATION_INDENT = /^(?: {1,4}|\t)/
const BLOCK_INDENT = /^(?: {4}|\t)/

/**
 * Every footnote reference and definition outside code. A definition runs
 * over the lines that follow it until a blank line, and on after a blank line
 * for lines indented four spaces or a tab, as in GFM. A reference with no
 * definition is text, and an inline `^[…]` footnote is not read at all.
 * Labels match without regard to case.
 */
export function scanFootnotes(markdown: string): Footnotes {
  if (!markdown.includes('[^')) return { references: [], definitions: [] }
  const masked = maskMarkdownCode(markdown)
  const definitions = scanDefinitions(markdown, masked)
  const markers = new Set(definitions.map((definition) => definition.start))
  const defined = new Set(definitions.map((definition) => definition.label.toLowerCase()))

  const numbers = new Map<string, number>()
  const references: FootnoteReference[] = []
  for (const match of masked.matchAll(REFERENCE)) {
    const key = match[1].toLowerCase()
    if (markers.has(match.index) || !defined.has(key)) continue
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
    references.push({
      label: match[1],
      number: numbers.get(key) as number,
      start: match.index,
      end: match.index + match[0].length
    })
  }

  const seen = new Set<string>()
  for (const definition of definitions) {
    const key = definition.label.toLowerCase()
    definition.number = seen.has(key) ? null : (numbers.get(key) ?? null)
    seen.add(key)
  }
  return { references, definitions }
}

function scanDefinitions(markdown: string, masked: string): FootnoteDefinition[] {
  const definitions: FootnoteDefinition[] = []
  let open: { definition: FootnoteDefinition; lines: string[]; blanks: number } | null = null
  const close = (): void => {
    if (!open) return
    open.definition.text = open.lines.join('\n').trim()
    definitions.push(open.definition)
    open = null
  }

  let offset = 0
  for (const rawLine of masked.split('\n')) {
    const lineStart = offset
    offset += rawLine.length + 1
    const length = rawLine.endsWith('\r') ? rawLine.length - 1 : rawLine.length
    const line = rawLine.slice(0, length)
    const source = markdown.slice(lineStart, lineStart + length)

    const marker = DEFINITION_LINE.exec(line)
    if (marker) {
      close()
      const start = lineStart + marker[1].length
      open = {
        definition: { label: marker[2], number: null, start, end: lineStart + length, text: '' },
        lines: [source.slice(marker[0].length)],
        blanks: 0
      }
      continue
    }
    if (!open) continue
    if (!line.trim()) {
      open.blanks++
      continue
    }
    if (open.blanks > 0 && !BLOCK_INDENT.test(line)) {
      close()
      continue
    }
    for (; open.blanks > 0; open.blanks--) open.lines.push('')
    open.lines.push(source.replace(CONTINUATION_INDENT, ''))
    open.definition.end = lineStart + length
  }
  close()
  return definitions
}
