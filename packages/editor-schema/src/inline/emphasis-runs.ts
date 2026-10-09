/**
 * Emphasis written as one span per run of marks (BBF-62).
 *
 * BlockNote's markdown export wraps every text run in its own marks, so
 * `**alpha *x y* omega**` (bold `alpha `, bold italic `x y`, bold ` omega`)
 * came back as `**alpha** ***x y***** omega**`: the bold closed and reopened
 * around the italic, and ` omega` reopened on a space, which CommonMark does
 * not read as emphasis. A bold run that starts with a space after a code span
 * broke the same way: `**`a` x `c`**` became `` `a`** x** `c` ``.
 *
 * Before the export, each run of neighbouring items holding a mark loses that
 * mark and sits between two tokens; after it, each token pair becomes one pair
 * of delimiters around the run, with the whitespace on its edges outside. The
 * mark spanning the most items opens first, ties in BlockNote's own order, so
 * a lone bold italic run still writes `***x***`.
 */

type Styles = Record<string, unknown>
export type InlineItem = {
  type: string
  text?: string
  styles?: Styles
  props?: Styles
  content?: unknown
}

const DELIMITERS = { bold: '**', italic: '*', strike: '~~' } as const
export type EmphasisMark = keyof typeof DELIMITERS
const MARKS = Object.keys(DELIMITERS) as EmphasisMark[]

// Drawn once per process, like the comment token's word (BBF-30), so note
// text does not hold a token. A token never leaves the write that made it.
const PROCESS_WORD = String.fromCharCode(
  ...crypto.getRandomValues(new Uint8Array(12)).map((byte) => 65 + (byte % 26))
)
const openToken = (index: number): string => `MEMRYEMO${PROCESS_WORD}${index};`
const closeToken = (index: number): string => `MEMRYEMC${PROCESS_WORD}${index};`
const TOKEN = new RegExp(`MEMRYEM([OC])${PROCESS_WORD}(\\d+);`, 'g')
const EDGES = /^((?:\\\n|\s)*)([\s\S]*?)((?:\\\n|\s)*)$/

function holds(item: InlineItem, mark: EmphasisMark): boolean {
  if (Array.isArray(item.content)) {
    const content = item.content as InlineItem[]
    return content.length > 0 && content.every((child) => holds(child, mark))
  }
  if (item.type === 'text') return item.styles?.[mark] === true && item.text !== ''
  return item.props?.[mark] === true
}

function without(item: InlineItem, mark: EmphasisMark): InlineItem {
  if (Array.isArray(item.content)) {
    return { ...item, content: (item.content as InlineItem[]).map((c) => without(c, mark)) }
  }
  const drop = (styles: Styles | undefined): Styles | undefined => {
    if (!styles) return styles
    const { [mark]: _dropped, ...rest } = styles
    return rest
  }
  return item.type === 'text'
    ? { ...item, styles: drop(item.styles) }
    : { ...item, props: drop(item.props) }
}

function runLength(items: InlineItem[], from: number, mark: EmphasisMark): number {
  let end = from
  while (end < items.length && holds(items[end], mark)) end++
  return end - from
}

/** `items` with every run of a mark between tokens; `marks` maps each token pair to its mark. */
export function tokenizeEmphasisRuns(items: InlineItem[], marks: EmphasisMark[]): InlineItem[] {
  const out: InlineItem[] = []
  let at = 0
  while (at < items.length) {
    let best: { mark: EmphasisMark; length: number } | null = null
    for (const mark of MARKS) {
      const length = runLength(items, at, mark)
      if (length > 0 && length > (best?.length ?? 0)) best = { mark, length }
    }
    if (!best) {
      const item = items[at++]
      out.push(
        Array.isArray(item.content)
          ? { ...item, content: tokenizeEmphasisRuns(item.content as InlineItem[], marks) }
          : item
      )
      continue
    }
    const { mark, length } = best
    const index = marks.push(mark) - 1
    const run = items.slice(at, at + length).map((item) => without(item, mark))
    out.push({ type: 'text', text: openToken(index), styles: {} })
    out.push(...tokenizeEmphasisRuns(run, marks))
    out.push({ type: 'text', text: closeToken(index), styles: {} })
    at += length
  }
  return out
}

/** Each token pair in `markdown` turned into its delimiters. Pairs nest, so one pass with a stack. */
export function restoreEmphasisRuns(markdown: string, marks: EmphasisMark[]): string {
  const open: string[] = ['']
  let last = 0
  for (const token of markdown.matchAll(TOKEN)) {
    open[open.length - 1] += markdown.slice(last, token.index)
    last = token.index + token[0].length
    if (token[1] === 'O') {
      open.push('')
      continue
    }
    if (open.length === 1) continue
    const run = open.pop() ?? ''
    const delimiter = DELIMITERS[marks[Number(token[2])]]
    const [, before, content, after] = EDGES.exec(run) ?? []
    open[open.length - 1] += content ? `${before}${delimiter}${content}${delimiter}${after}` : run
  }
  // A pair the serializer cut short keeps its text, without delimiters.
  return open.join('') + markdown.slice(last)
}
