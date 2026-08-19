/**
 * Streaming literal search over a large-file-class vault file.
 *
 * Large files never enter FTS, so the global search box cannot see inside them
 * — this is the only way to find anything in one. It is a sibling of
 * `large-file-index.ts` and obeys the same rule: the file is never held. One
 * pass reads fixed windows through a `ByteReader`, counts newlines as it goes,
 * and reports each hit as a line plus which occurrence on that line it is.
 *
 * Bytes, not text, on purpose:
 *
 * - Decoding each window on its own would corrupt any multi-byte character
 *   straddling the boundary. Matching encoded bytes never decodes at all, and
 *   UTF-8 is self-synchronising, so a valid encoded query can only align with a
 *   whole character in valid UTF-8 — a byte match is a character match.
 * - Case folding is ASCII-only. `toLowerCase()` changes the length of some
 *   characters ('İ' becomes two), which would shift every offset the pass is
 *   counting. A-Z never appear inside a multi-byte sequence, so folding them is
 *   safe and length-preserving. The trade is that 'É' does not match 'é'.
 *
 * The renderer highlights the visible window by re-finding occurrences in the
 * line text it already has, with the same ASCII fold and the same
 * non-overlapping advance, so its Nth match on a line is this pass's ordinal N.
 */

import type { ByteReader } from './large-file-index'

/** Window one pass reads at a time. Matches the line-index scan's window. */
export const SEARCH_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Hit positions kept for navigation.
 *
 * A 2 GB log dump searched for `e` holds hundreds of millions of matches;
 * keeping them would put the file back in memory in another shape. The count is
 * exact regardless — only the navigable list is bounded.
 */
export const MAX_SEARCH_HITS = 2000

const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d
const UPPERCASE_A = 0x41
const UPPERCASE_Z = 0x5a
const CASE_SHIFT = 0x20

/** One match: which line, and which occurrence on that line. */
export interface LargeFileHit {
  line: number
  ordinal: number
}

export interface FindMatchesOptions {
  query: string
  chunkBytes?: number
  maxHits?: number
  /** `total` is the count so far, not the final one. */
  onProgress?: (bytesSearched: number, total: number) => void
  /** Checked between windows, so a superseded query stops within one read. */
  shouldStop?: () => boolean
}

export interface FindMatchesResult {
  hits: LargeFileHit[]
  /** Every match in the file, even the ones past `maxHits`. */
  total: number
  /** True when `hits` was cut at `maxHits` and `total` is larger. */
  limited: boolean
  cancelled: boolean
  bytesSearched: number
}

/** Lowercase the ASCII letters of `buffer` in place, leaving every other byte. */
function foldAsciiCase(buffer: Buffer, length: number): void {
  for (let i = 0; i < length; i++) {
    const byte = buffer[i]
    if (byte >= UPPERCASE_A && byte <= UPPERCASE_Z) buffer[i] = byte + CASE_SHIFT
  }
}

/**
 * One streaming pass, counting every match and collecting the first `maxHits`.
 *
 * Every `await read(...)` is a yield point, so this occupies a thread for no
 * longer than one window at a time even when it runs in-process.
 */
export async function findMatches(
  read: ByteReader,
  options: FindMatchesOptions
): Promise<FindMatchesResult> {
  const maxHits = options.maxHits ?? MAX_SEARCH_HITS
  const empty: FindMatchesResult = {
    hits: [],
    total: 0,
    limited: false,
    cancelled: false,
    bytesSearched: 0
  }

  const needle = Buffer.from(options.query, 'utf8')
  foldAsciiCase(needle, needle.length)
  // A query spanning lines has no position the viewer could point at, since
  // every hit is addressed as a line plus an occurrence on it. It would also
  // break the invariant the line accounting below rests on: no match contains a
  // newline, so a match never spans two lines.
  if (needle.length === 0 || needle.includes(NEWLINE) || needle.includes(CARRIAGE_RETURN)) {
    return empty
  }

  // The overlap carried between windows is one byte short of the query, so a
  // match can straddle a boundary and still be seen whole exactly once.
  const carryBytes = needle.length - 1
  const chunkBytes = Math.max(options.chunkBytes ?? SEARCH_CHUNK_BYTES, needle.length * 2)

  const buffer = Buffer.allocUnsafe(chunkBytes)
  const window = Buffer.allocUnsafe(carryBytes + chunkBytes)

  const hits: LargeFileHit[] = []
  let total = 0
  let line = 0
  let ordinal = 0
  let position = 0
  let carryLength = 0
  /**
   * Absolute byte offset matching may resume from. Matches do not overlap, so a
   * counted match consumes its own bytes — and carrying this across windows is
   * what stops the tail of a window from re-reporting what its head already
   * reported.
   */
  let resumeAt = 0
  let cancelled = false

  for (;;) {
    if (options.shouldStop?.()) {
      cancelled = true
      break
    }

    const bytesRead = await read(buffer, position)
    if (bytesRead <= 0) break

    foldAsciiCase(buffer, bytesRead)
    buffer.copy(window, carryLength, 0, bytesRead)
    const view = window.subarray(0, carryLength + bytesRead)
    const viewStart = position - carryLength

    // Newlines inside the carry were counted with the previous window; matches
    // are skipped by `resumeAt` instead, which also covers the carry.
    let newlineFrom = carryLength
    let matchFrom = Math.max(0, resumeAt - viewStart)

    for (;;) {
      const match = view.indexOf(needle, matchFrom)
      const newline = view.indexOf(NEWLINE, newlineFrom)
      if (match < 0 && newline < 0) break

      if (match >= 0 && (newline < 0 || match < newline)) {
        total += 1
        if (hits.length < maxHits) hits.push({ line, ordinal })
        ordinal += 1
        matchFrom = match + needle.length
        resumeAt = viewStart + matchFrom
        continue
      }

      line += 1
      ordinal = 0
      newlineFrom = newline + 1
    }

    position += bytesRead
    carryLength = Math.min(carryBytes, view.length)
    if (carryLength > 0) view.copy(window, 0, view.length - carryLength)

    options.onProgress?.(position, total)
  }

  return {
    hits,
    total,
    limited: total > hits.length,
    cancelled,
    bytesSearched: position
  }
}
