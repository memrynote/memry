import type { LegacyReading } from '@memry/shared/markdown-code'
import { createFenceTracker } from '@memry/shared/markdown-fences'
import { MASK_WORD } from '@memry/shared/mask-word'

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
 * A code span of nothing but spaces and tabs is masked on any line, since a
 * block that held only such spans read back empty and was dropped: `` ` ` ``
 * came back as no paragraph, and `- ` `` as a bare `-`. Only that span's
 * whitespace is hidden, on a line with no pipe.
 *
 * `pipes: false` masks whitespace only, as builds before lossless tables did,
 * for reading a source the way an older build read it.
 */

/**
 * A backtick fence opener whose info string holds a backtick. CommonMark opens
 * no fence there, so the fence tracker does not skip the line, but BlockNote's
 * block tokenizer does read it as one, at any depth a list item strips the
 * indent to, and trims its language: ```` ```  ``` x ````
 * is the language ```` ``` x ````. Masked, the span of blanks it holds would
 * keep them in the language, a language no markdown can spell back (a tilde
 * fence is trimmed too) and one the core's seed, which reads the language as
 * BlockNote does, never builds.
 */
const TICKED_FENCE_OPENER = /^ *`{3,}[^`\n]*`/

const UNSAFE_LINE = /[[\]]|<(?!br\s*\/?>)/i
const CODE_TOKEN = new RegExp(`MEMRYCSP${MASK_WORD}(\\d+)X`, 'g')

const placeholder = (index: number): string => `MEMRYCSP${MASK_WORD}${index}X`

export interface MaskedCellCodeSpans {
  markdown: string
  /** The masked characters, by placeholder index. */
  chars: string[]
}

interface MaskedChars {
  spaces: boolean
  pipes: boolean
  /** Only a code span of spaces and tabs alone is touched. */
  blankOnly?: boolean
}

function maskCodeContent(content: string, chars: string[], masked: MaskedChars): string {
  if (masked.blankOnly && !/^[ \t]+$/.test(content)) return content
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

/** The maximal runs of backticks in `line`, as `[start, length]`, in order. */
function backtickRuns(line: string): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < line.length;) {
    if (line[i] !== '`') {
      i++
      continue
    }
    let end = i + 1
    while (line[end] === '`') end++
    runs.push([i, end - i])
    i = end
  }
  return runs
}

/** The first of the ascending `indexes` past `after`. */
function firstAfter(indexes: number[] | undefined, after: number): number | undefined {
  if (!indexes) return undefined
  let low = 0
  let high = indexes.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (indexes[mid] > after) high = mid
    else low = mid + 1
  }
  return indexes[low]
}

/**
 * A backslash skips the character after it. A span opens at a run of
 * backticks, or at a later backtick of it, and closes on the first later run
 * of exactly its length, which a
 * lookup by length finds in log time, so a line of runs no run closes costs
 * no scan per opener.
 */
function maskLine(line: string, chars: string[], masked: MaskedChars, retries: boolean): string {
  const runs = backtickRuns(line)
  const byLength = new Map<number, number[]>()
  for (const [index, [, length]] of runs.entries()) {
    const same = byLength.get(length)
    if (same) same.push(index)
    else byLength.set(length, [index])
  }
  let out = ''
  let i = 0
  let at = 0
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
    while (runs[at][0] + runs[at][1] <= i) at++
    const run = runs[at][0] + runs[at][1] - i
    // The parser retries from each later backtick of a run with no closer of
    // its length against the shorter run left: `` ``x ` `` is a backtick and
    // the span `` `x ` ``.
    let width = run
    let closer = firstAfter(byLength.get(width), at)
    const shortest = retries ? 1 : run
    while (closer === undefined && width > shortest) {
      width--
      closer = firstAfter(byLength.get(width), at)
    }
    if (closer === undefined) {
      out += line.slice(i, i + run)
      i += run
      continue
    }
    const close = runs[closer][0]
    out +=
      line.slice(i, i + run) +
      maskCodeContent(line.slice(i + run, close), chars, masked) +
      line.slice(close, close + width)
    i = close + width
  }
  return out
}

/**
 * `legacy.html` reads a span as builds before raw HTML stayed text did: no
 * retry from a later backtick of a run, and a fence opener's line holds spans
 * like any other.
 */
export function maskCellCodeSpans(
  markdown: string,
  { pipes, legacy = {} }: { pipes: boolean; legacy?: LegacyReading }
): MaskedCellCodeSpans {
  if (!markdown.includes('`')) return { markdown, chars: [] }
  const chars: string[] = []
  const fence = createFenceTracker()
  const masked = markdown
    .split('\n')
    .map((line) => {
      if (fence.consume(line) || (!legacy.html && TICKED_FENCE_OPENER.test(line))) return line
      if (!line.includes('|')) {
        return maskLine(line, chars, { spaces: true, pipes: false, blankOnly: true }, !legacy.html)
      }
      const spaces = !UNSAFE_LINE.test(line)
      return spaces || pipes ? maskLine(line, chars, { spaces, pipes }, !legacy.html) : line
    })
    .join('\n')
  return chars.length === 0 ? { markdown, chars: [] } : { markdown: masked, chars }
}

/** A placeholder with no masked character is the author's own text and stays. */
export function restoreCellCodeSpans(text: string, chars: string[]): string {
  if (chars.length === 0) return text
  return text.replace(CODE_TOKEN, (whole, index: string) => chars[Number(index)] ?? whole)
}
