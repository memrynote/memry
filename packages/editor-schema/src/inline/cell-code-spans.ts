import { createFenceTracker } from '@memry/shared/markdown-fences'

/**
 * The inside of a code span in a table row, hidden from the parser.
 *
 * BlockNote parses a table cell without preserving whitespace, so ProseMirror
 * collapses it the way a browser would, code spans included. Measured on 0.54:
 * `| a ` x` |` comes back as `a `x``, `| `a  b` |` as `` `a b` ``, and
 * `| `x ` b |` as `` `x `b ``. A paragraph keeps all three. Each write-back of
 * a cell then rewrote the author's code (BBF-90).
 *
 * BlockNote also splits a row on every unescaped pipe before it reads a code
 * span, so `| x | `p|q` |` lost `q`` to a cell past the header's width. A code
 * span is one piece of text: each pipe in it travels as a placeholder too, and
 * the row splits around it. A `\|` stays as written, for the splitter to turn
 * into the pipe the writer escaped it from.
 *
 * Every space and tab a code span keeps travels as a placeholder and is put
 * back once the blocks exist. The one space on each side that CommonMark
 * strips (content that opens and closes with a space) stays literal so the
 * parser still strips it.
 *
 * Only lines with a pipe, outside fences, are touched. Whitespace is left
 * alone in a line with link syntax or HTML other than `<br>`, where a masked
 * space would change how the link or the tag parses; a pipe there is masked,
 * and the restore reaches link addresses and props as well as text, so a
 * placeholder never reaches the vault.
 *
 * `pipes: false` masks whitespace only, as builds before lossless tables did,
 * for reading a source the way an older build read it.
 */

const UNSAFE_LINE = /[[\]]|<(?!br\s*\/?>)/i
const CODE_TOKEN = /MEMRYCSP(\d+)X/g

const placeholder = (index: number): string => `MEMRYCSP${index}X`

export interface MaskedCellCodeSpans {
  markdown: string
  /** The masked characters, by placeholder index. */
  chars: string[]
}

interface MaskedChars {
  spaces: boolean
  pipes: boolean
}

function maskCodeContent(content: string, chars: string[], masked: MaskedChars): string {
  const stripped = masked.spaces && /^ [\s\S]* $/.test(content) && content.trim() !== ''
  const inner = stripped ? content.slice(1, -1) : content
  const hide = (ch: string): string => {
    chars.push(ch)
    return placeholder(chars.length - 1)
  }
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    const space = masked.spaces && (ch === ' ' || ch === '\t')
    const pipe = masked.pipes && ch === '|' && inner[i - 1] !== '\\'
    out += space || pipe ? hide(ch) : ch
  }
  return stripped ? ` ${out} ` : out
}

function maskLine(line: string, chars: string[], masked: MaskedChars): string {
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
    out += run + maskCodeContent(line.slice(i + run.length, close.index), chars, masked) + run
    i = close.index + run.length
  }
  return out
}

export function maskCellCodeSpans(
  markdown: string,
  { pipes }: { pipes: boolean }
): MaskedCellCodeSpans {
  if (!markdown.includes('`') || !markdown.includes('|')) return { markdown, chars: [] }
  const chars: string[] = []
  const fence = createFenceTracker()
  const masked = markdown
    .split('\n')
    .map((line) => {
      if (fence.consume(line) || !line.includes('|')) return line
      const spaces = !UNSAFE_LINE.test(line)
      return spaces || pipes ? maskLine(line, chars, { spaces, pipes }) : line
    })
    .join('\n')
  return chars.length === 0 ? { markdown, chars: [] } : { markdown: masked, chars }
}

/** A placeholder with no masked character is the author's own text and stays. */
export function restoreCellCodeSpans(text: string, chars: string[]): string {
  if (chars.length === 0) return text
  return text.replace(CODE_TOKEN, (whole, index: string) => chars[Number(index)] ?? whole)
}
