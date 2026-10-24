/**
 * A small inline-Markdown reader for the folded view. The engine hands over one
 * sentence of inline Markdown (bold, italic, strike, code, links, wiki-links),
 * and this turns it into a tree that React renders as elements. There is no
 * HTML anywhere: text only ever becomes text nodes.
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'wiki'; label: string }
  | { type: 'strong' | 'em' | 'del' | 'link'; children: InlineNode[] }

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|<>]/
const WORD_CHAR = /[\p{L}\p{N}]/u
const DELIMITERS = ['**', '__', '~~', '*', '_'] as const

/** Index of the `]` or `)` that closes the bracket at `open`, honoring nesting; -1 when unbalanced. */
function closingBracket(text: string, open: number): number {
  const opener = text[open]
  const closer = opener === '[' ? ']' : ')'
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === opener) depth++
    else if (text[i] === closer && --depth === 0) return i
  }
  return -1
}

function closingDelimiter(text: string, delimiter: string, from: number): number {
  for (let at = text.indexOf(delimiter, from); at !== -1; at = text.indexOf(delimiter, at + 1)) {
    if (at === from || /\s/.test(text[at - 1])) continue
    if (delimiter.length === 1) {
      // A lone * or _ is not half of a double one, and _ ends at a word edge.
      if (text[at + 1] === delimiter || text[at - 1] === delimiter) continue
      if (delimiter === '_' && WORD_CHAR.test(text[at + 1] ?? '')) continue
    }
    return at
  }
  return -1
}

export function parseInline(markdown: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer) nodes.push({ type: 'text', text: buffer })
    buffer = ''
  }

  let i = 0
  scan: while (i < markdown.length) {
    const char = markdown[i]

    if (char === '\\' && i + 1 < markdown.length && ESCAPABLE.test(markdown[i + 1])) {
      buffer += markdown[i + 1]
      i += 2
      continue
    }

    if (char === '`') {
      let ticks = 1
      while (markdown[i + ticks] === '`') ticks++
      const fence = '`'.repeat(ticks)
      const end = markdown.indexOf(fence, i + ticks)
      if (end > i + ticks) {
        flush()
        nodes.push({ type: 'code', text: markdown.slice(i + ticks, end).trim() })
        i = end + ticks
      } else {
        buffer += fence
        i += ticks
      }
      continue
    }

    if (char === '[') {
      if (markdown.startsWith('[[', i)) {
        const end = markdown.indexOf(']]', i + 2)
        if (end > i + 2) {
          const inner = markdown.slice(i + 2, end)
          const alias = inner.includes('|') ? inner.slice(inner.lastIndexOf('|') + 1) : ''
          flush()
          nodes.push({ type: 'wiki', label: alias.trim() || inner.split('|')[0].trim() })
          i = end + 2
          continue
        }
      }
      const close = closingBracket(markdown, i)
      const destination =
        close === -1 || markdown[close + 1] !== '(' ? -1 : closingBracket(markdown, close + 1)
      if (destination !== -1) {
        const children = parseInline(markdown.slice(i + 1, close))
        // An image keeps its alt text and drops the "!" the text run already took.
        if (buffer.endsWith('!')) {
          buffer = buffer.slice(0, -1)
          flush()
          nodes.push(...children)
        } else {
          flush()
          nodes.push({ type: 'link', children })
        }
        i = destination + 1
        continue
      }
    }

    for (const delimiter of DELIMITERS) {
      if (!markdown.startsWith(delimiter, i)) continue
      const start = i + delimiter.length
      const wordEdge = delimiter === '_' || delimiter === '__'
      const closes =
        /\s/.test(markdown[start] ?? ' ') || (wordEdge && WORD_CHAR.test(markdown[i - 1] ?? ''))
          ? -1
          : closingDelimiter(markdown, delimiter, start)
      if (closes === -1) {
        buffer += delimiter
        i = start
        continue scan
      }
      flush()
      const type =
        delimiter === '**' || delimiter === '__' ? 'strong' : delimiter === '~~' ? 'del' : 'em'
      nodes.push({ type, children: parseInline(markdown.slice(start, closes)) })
      i = closes + delimiter.length
      continue scan
    }

    buffer += char
    i++
  }
  flush()
  return nodes
}
