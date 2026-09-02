/**
 * The author's bytes, carried across the round trip (#1915).
 *
 * A markdown file Memry did not write comes back re-spelled in house style:
 * `* One` as `- One`, `_em_` as `*em*`, an underlined heading as `# Title`,
 * `---` as `***`, a list glued to its paragraph pushed one blank line down, a
 * four-space nested indent narrowed to two. Each is harmless read by a person
 * and together they are a `git diff` over every file the user pointed us at.
 * The block tree has nowhere to record any of them, and the serializer's
 * choices are per call, not per node, so re-deriving the bytes from the tree
 * can never get them back.
 *
 * So the bytes are kept instead. When a document is seeded from markdown, the
 * source and what the pipeline serialized it to are stored beside the document
 * — the shape #1909 used for reference definitions, and nothing an older build
 * reads. On the way out the current serialization is merged three ways at line
 * granularity: `base` is the canonical text at seed time, `ours` is the
 * canonical text now, `theirs` is the source. A region only the source differs
 * in is the author's spelling of unchanged content and comes back as written;
 * a region the document changed comes back in house style; a region both
 * changed is a real edit inside a re-spelled construct and house style wins.
 * Lines nobody changed separate regions, so an edit next to a re-spelled list
 * takes the whole list with it rather than splitting it on its bullet.
 *
 * A line-level splice of two markdown texts is not guaranteed to parse to
 * either input, so the merge is never trusted on its own: the caller re-parses
 * the merged bytes and only writes them when they canonicalize to exactly what
 * the document serializes to now. Anything else falls back to house style,
 * which is what every build before this one wrote.
 */

export interface MarkdownSourceRecord {
  /** The body as the author wrote it, at the layer the serializer returns. */
  source: string
  /** What the pipeline serialized that source to, the moment it was seeded. */
  canonical: string
}

/** `null` when the source is already in house style — nothing to carry. */
export function recordMarkdownSource(
  source: string,
  canonical: string
): MarkdownSourceRecord | null {
  return source === canonical ? null : { source, canonical }
}

/**
 * Re-parses markdown through the same pipeline that produced `canonicalNow`.
 * `null` when the parse fails, which counts as a failed proof.
 */
export type Canonicalize = (markdown: string) => Promise<string | null>

/**
 * The bytes to write for a document that serializes to `canonicalNow`.
 *
 * Returns the source untouched when the document has not changed since it
 * was seeded, the merge when the merged bytes are proven to mean exactly what
 * the document means, and `canonicalNow` otherwise.
 */
export async function restoreMarkdownSource(
  canonicalNow: string,
  record: MarkdownSourceRecord | null,
  canonicalize: Canonicalize
): Promise<string> {
  if (!record) return canonicalNow
  if (canonicalNow === record.canonical) return record.source
  const merged = mergeMarkdownSource(record, canonicalNow)
  if (merged === null || merged === canonicalNow) return canonicalNow
  const proof = await canonicalize(merged)
  return proof === canonicalNow ? merged : canonicalNow
}

/**
 * The unproven three-way merge. Exported so the merge can be pinned on its
 * own; every writer goes through `restoreMarkdownSource`.
 *
 * `null` when a diff exceeds `MAX_EDIT_DISTANCE`, which bounds the memory of
 * the Myers history on a file that shares nothing with its own canonical form.
 */
export function mergeMarkdownSource(
  record: MarkdownSourceRecord,
  canonicalNow: string
): string | null {
  const base = record.canonical.split('\n')
  const ours = canonicalNow.split('\n')
  const theirs = record.source.split('\n')

  const oursHunks = diffLines(base, ours, markdownAlignmentKey)
  if (!oursHunks) return null
  const theirsHunks = diffLines(base, theirs, markdownAlignmentKey)
  if (!theirsHunks) return null

  const hunks: TaggedHunk[] = [
    ...oursHunks.map((hunk) => ({ ...hunk, side: 'ours' as const })),
    ...theirsHunks.map((hunk) => ({ ...hunk, side: 'theirs' as const }))
  ].sort((a, b) => a.baseStart - b.baseStart)

  const out: string[] = []
  let baseCursor = 0

  for (let i = 0; i < hunks.length;) {
    const regionStart = hunks[i].baseStart
    let regionEnd = regionStart + hunks[i].baseLength
    const region: TaggedHunk[] = [hunks[i]]
    i++
    // Adjacent hunks (no stable base line between them) are one region: an
    // item appended to a `*` list sits right after the lines the source
    // re-spells, and splitting them would write `* a\n* b\n- c`, three lists.
    while (i < hunks.length && hunks[i].baseStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[i].baseStart + hunks[i].baseLength)
      region.push(hunks[i])
      i++
    }

    for (let line = baseCursor; line < regionStart; line++) out.push(base[line])
    baseCursor = regionEnd

    const oursText = sideSlice(ours, region, 'ours', regionStart, regionEnd)
    const theirsText = sideSlice(theirs, region, 'theirs', regionStart, regionEnd)
    if (oursText === null) out.push(...(theirsText as string[]))
    else if (theirsText === null) out.push(...oursText)
    else out.push(...(sameLines(oursText, theirsText) ? theirsText : oursText))
  }

  for (let line = baseCursor; line < base.length; line++) out.push(base[line])
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Shared-doc channel
// ---------------------------------------------------------------------------

export const MARKDOWN_SOURCE_MAP = 'markdownSource'

// One key, one value: two keys would be two last-writer-wins races, and a
// base from one seed with a source from another merges into nonsense.
const RECORD_KEY = 'record'

interface YMapLike {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
  has(key: string): boolean
}

interface YDocLike {
  getMap(name: string): YMapLike
}

export function writeMarkdownSourceToYDoc(
  doc: YDocLike,
  record: MarkdownSourceRecord | null
): void {
  const map = doc.getMap(MARKDOWN_SOURCE_MAP)
  if (!record) {
    if (map.has(RECORD_KEY)) map.delete(RECORD_KEY)
    return
  }
  const current = normalizeRecord(map.get(RECORD_KEY))
  if (current && current.source === record.source && current.canonical === record.canonical) {
    return
  }
  map.set(RECORD_KEY, { source: record.source, canonical: record.canonical })
}

export function readMarkdownSourceFromYDoc(doc: YDocLike): MarkdownSourceRecord | null {
  return normalizeRecord(doc.getMap(MARKDOWN_SOURCE_MAP).get(RECORD_KEY))
}

function normalizeRecord(value: unknown): MarkdownSourceRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.source !== 'string' || typeof record.canonical !== 'string') return null
  return { source: record.source, canonical: record.canonical }
}

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

export interface LineHunk {
  baseStart: number
  baseLength: number
  sideStart: number
  sideLength: number
}

interface TaggedHunk extends LineHunk {
  side: 'ours' | 'theirs'
}

/**
 * Myers' O(ND) diff keeps one row of the search per edit-distance step for
 * the backtrack, so its memory is quadratic in the distance. A file that
 * shares no line with its canonical form is the only way to reach this, and
 * house style is the right answer for it anyway.
 */
export const MAX_EDIT_DISTANCE = 2000

/**
 * What a line looks like with the spellings this module carries erased: the
 * heading, bullet and quote markers in front of it, the emphasis characters,
 * the whitespace. Two lines with the same key are the same content spelled two
 * ways, which is exactly what the source and its canonical form are made of.
 *
 * Aligning on this rather than on bytes is what keeps a blank line from being
 * matched across a list — a minimal Myers script is free to pair the blank
 * ABOVE a re-spelled list in the base with the blank BELOW it in the source,
 * which turns the list into an insertion on one side and a conflict on the
 * other and writes it twice. Stability stays byte-exact: a key-equal pair whose
 * bytes differ is a one-line change, never a stable line.
 */
function markdownAlignmentKey(line: string): string {
  return line
    .trim()
    .replace(/^[#>*+\-\s]+/, '')
    .replace(/[_*]/g, '')
    .replace(/\s+/g, ' ')
}

/**
 * The edit script from `a` to `b`, as hunks in ascending order. Minimal over
 * `key`, and lines that `key` equates but that differ byte for byte become
 * single-line change hunks on top of that. `null` when the edit distance
 * exceeds `MAX_EDIT_DISTANCE`.
 */
export function diffLines(
  a: readonly string[],
  b: readonly string[],
  key: (line: string) => string = (line) => line
): LineHunk[] | null {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const n = a.length - prefix - suffix
  const m = b.length - prefix - suffix
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0) {
    return [{ baseStart: prefix, baseLength: n, sideStart: prefix, sideLength: m }]
  }

  const aligned = myersMatches(a.map(key), b.map(key), prefix, n, m)
  if (!aligned) return null
  const matches = aligned.filter(([ai, bi]) => a[ai] === b[bi])

  const hunks: LineHunk[] = []
  let ai = prefix
  let bi = prefix
  const gapBefore = (ma: number, mb: number): void => {
    if (ma > ai || mb > bi) {
      hunks.push({ baseStart: ai, baseLength: ma - ai, sideStart: bi, sideLength: mb - bi })
    }
  }
  for (const [ma, mb] of matches) {
    gapBefore(ma, mb)
    ai = ma + 1
    bi = mb + 1
  }
  gapBefore(prefix + n, prefix + m)
  return hunks
}

/**
 * Matched line pairs `[aIndex, bIndex]` in ascending order, for the middle of
 * `a` and `b` that the common prefix and suffix leave.
 */
function myersMatches(
  a: readonly string[],
  b: readonly string[],
  offset: number,
  n: number,
  m: number
): Array<[number, number]> | null {
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE)
  // v[k + limit + 1] is the furthest x on diagonal k; the +1 keeps k = ±(d+1)
  // addressable at the edges.
  const v = new Int32Array(2 * limit + 3)
  const at = (k: number): number => k + limit + 1
  // history[d][k + d] is v[k] after step d, for the backtrack.
  const history: Int32Array[] = []

  v[at(1)] = 0
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[at(k - 1)] < v[at(k + 1)]) ? v[at(k + 1)] : v[at(k - 1)] + 1
      let y = x - k
      while (x < n && y < m && a[offset + x] === b[offset + y]) {
        x++
        y++
      }
      v[at(k)] = x
      if (x >= n && y >= m) {
        history.push(v.slice(at(-d), at(d) + 1))
        return backtrack(history, d, n, m, offset)
      }
    }
    history.push(v.slice(at(-d), at(d) + 1))
  }
  return null
}

function backtrack(
  history: Int32Array[],
  distance: number,
  n: number,
  m: number,
  offset: number
): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = distance; d > 0; d--) {
    const previous = history[d - 1]
    const prevAt = (k: number): number => previous[k + d - 1]
    const k = x - y
    const prevK = k === -d || (k !== d && prevAt(k - 1) < prevAt(k + 1)) ? k + 1 : k - 1
    const prevX = prevAt(prevK)
    const prevY = prevX - prevK
    const snakeStartX = prevK === k - 1 ? prevX + 1 : prevX
    const snakeStartY = snakeStartX - k
    while (x > snakeStartX && y > snakeStartY) {
      x--
      y--
      matches.push([offset + x, offset + y])
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    matches.push([offset + x, offset + y])
  }
  return matches.reverse()
}

/**
 * One side's lines for a base region, or `null` when that side has no hunk
 * there. Between a side's hunks its lines equal the base lines, shifted by
 * the hunks before them, so the region's edges are found from the nearest
 * hunk on each end.
 */
function sideSlice(
  lines: readonly string[],
  region: readonly TaggedHunk[],
  side: 'ours' | 'theirs',
  regionStart: number,
  regionEnd: number
): string[] | null {
  const own = region.filter((hunk) => hunk.side === side)
  if (own.length === 0) return null
  const first = own[0]
  const last = own[own.length - 1]
  const start = first.sideStart - (first.baseStart - regionStart)
  const end = last.sideStart + last.sideLength + (regionEnd - (last.baseStart + last.baseLength))
  return lines.slice(start, end)
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index])
}
