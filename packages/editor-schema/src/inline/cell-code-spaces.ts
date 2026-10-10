import { createFenceTracker } from '@memry/shared/markdown-fences'

/**
 * Whitespace inside a code span in a table row, hidden from the parser.
 *
 * BlockNote parses a table cell without preserving whitespace, so ProseMirror
 * collapses it the way a browser would, code spans included. Measured on 0.54:
 * `| a ` x` |` comes back as `a `x``, `| `a  b` |` as `` `a b` ``, and
 * `| `x ` b |` as `` `x `b ``. A paragraph keeps all three. Each write-back of
 * a cell then rewrote the author's code (BBF-90).
 *
 * Every space and tab a code span keeps travels as a placeholder and is put
 * back once the blocks exist. The one space on each side that CommonMark
 * strips (content that opens and closes with a space) stays literal so the
 * parser still strips it.
 *
 * Only lines with a pipe, outside fences, are touched, and never a line with
 * link syntax or HTML other than `<br>`: link text, URLs and attributes never
 * reach the restore, and a placeholder must never reach the vault.
 */

const UNSAFE_LINE = /[[\]]|<(?!br\s*\/?>)/i
const SPACE_TOKEN = /MEMRYCSP(\d+)X/g

const placeholder = (index: number): string => `MEMRYCSP${index}X`

export interface MaskedCellCodeSpaces {
  markdown: string
  /** The masked whitespace characters, by placeholder index. */
  spaces: string[]
}

function maskCodeContent(content: string, spaces: string[]): string {
  const stripped = /^ [\s\S]* $/.test(content) && content.trim() !== ''
  const inner = stripped ? content.slice(1, -1) : content
  const masked = inner.replace(/[ \t]/g, (ch) => {
    spaces.push(ch)
    return placeholder(spaces.length - 1)
  })
  return stripped ? ` ${masked} ` : masked
}

function maskLine(line: string, spaces: string[]): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length) {
      out += line.slice(i, i + 2)
      i += 2
      continue
    }
    if (line[i] !== '`') {
      out += line[i]
      i++
      continue
    }
    const run = /^`+/.exec(line.slice(i))![0]
    const closer = new RegExp(`(?<!\`)${run}(?!\`)`, 'g')
    closer.lastIndex = i + run.length
    const close = closer.exec(line)
    if (!close) {
      out += run
      i += run.length
      continue
    }
    out += run + maskCodeContent(line.slice(i + run.length, close.index), spaces) + run
    i = close.index + run.length
  }
  return out
}

export function maskCellCodeSpaces(markdown: string): MaskedCellCodeSpaces {
  if (!markdown.includes('`') || !markdown.includes('|')) return { markdown, spaces: [] }
  const spaces: string[] = []
  const fence = createFenceTracker()
  const masked = markdown
    .split('\n')
    .map((line) => {
      if (fence.consume(line) || !line.includes('|') || UNSAFE_LINE.test(line)) return line
      return maskLine(line, spaces)
    })
    .join('\n')
  return spaces.length === 0 ? { markdown, spaces: [] } : { markdown: masked, spaces }
}

/** A placeholder with no masked character is the author's own text and stays. */
export function restoreCellCodeSpaces(text: string, spaces: string[]): string {
  if (spaces.length === 0) return text
  return text.replace(SPACE_TOKEN, (whole, index: string) => spaces[Number(index)] ?? whole)
}
