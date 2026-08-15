import { describe, it, expect } from 'vitest'
import { findMatches, type FindMatchesOptions } from './large-file-search'
import type { ByteReader } from './large-file-index'

/**
 * A reader over an in-memory buffer, so the search can be driven at window
 * sizes no fixture would justify. Production reads through a file handle with
 * the same signature, which is what makes a 4-byte window here exercise the
 * boundary the 4 MB window hits once every few megabytes.
 */
function bufferReader(bytes: Buffer): ByteReader {
  return async (buffer, position) => {
    if (position >= bytes.length) return 0
    const end = Math.min(position + buffer.length, bytes.length)
    bytes.copy(buffer, 0, position, end)
    return end - position
  }
}

async function search(text: string, options: FindMatchesOptions) {
  const bytes = Buffer.from(text, 'utf8')
  return findMatches(bufferReader(bytes), options)
}

describe('findMatches', () => {
  it('answers with the line and the position within the line of every match', async () => {
    // #given a file where one line holds the query twice
    const text = 'alpha beta\nbeta and beta again\nnothing\n'

    // #when
    const found = await search(text, { query: 'beta' })

    // #then — the viewer addresses content by line, so a hit is a line plus
    // which occurrence on it; nothing here is a byte offset the renderer would
    // have to translate back into a character.
    expect(found.hits).toEqual([
      { line: 0, ordinal: 0 },
      { line: 1, ordinal: 0 },
      { line: 1, ordinal: 1 }
    ])
    expect(found.total).toBe(3)
    expect(found.limited).toBe(false)
  })

  it('finds a match that straddles a read window', async () => {
    // #given "needle" split across the boundary of every 4-byte window
    const text = 'aaaa needle aaaa\n'

    // #when
    const found = await search(text, { query: 'needle', chunkBytes: 4 })

    // #then — a search that decided one window at a time would miss this
    // entirely, which is the bug this shape of code always has
    expect(found.hits).toEqual([{ line: 0, ordinal: 0 }])
    expect(found.total).toBe(1)
  })

  it('counts a match at a window boundary once, not once per window', async () => {
    // #given a match ending exactly where a window ends, and another crossing
    const text = 'xxlog\nlogxx\n'

    // #when — window 5 puts the first "log" flush against the boundary
    const found = await search(text, { query: 'log', chunkBytes: 5 })

    // #then — the overlap carried between windows must not re-report what the
    // previous window already reported
    expect(found.total).toBe(2)
    expect(found.hits).toEqual([
      { line: 0, ordinal: 0 },
      { line: 1, ordinal: 0 }
    ])
  })

  it('keeps a multi-byte character whole across a window boundary', async () => {
    // #given a 3-byte character sitting astride every window edge, and the
    // query immediately after it
    const text = '一二三café\n三一二naïve\n'

    // #when — 4-byte windows cut inside the multi-byte characters
    const found = await search(text, { query: 'café', chunkBytes: 4 })

    // #then — decoding each window on its own would turn the split character
    // into replacement characters and lose the match beside it
    expect(found.hits).toEqual([{ line: 0, ordinal: 0 }])
    expect(found.total).toBe(1)
  })

  it('finds a query that is itself multi-byte across a window boundary', async () => {
    // #given nine 3-byte characters, and a query of two of them. The third
    // occurrence starts at byte 21 and a 12-byte window ends at byte 24, so the
    // query's own encoding is cut in half.
    const text = '一二三'.repeat(3) + '\n'

    // #when
    const found = await search(text, { query: '二三', chunkBytes: 12 })

    // #then
    expect(found.hits).toEqual([
      { line: 0, ordinal: 0 },
      { line: 0, ordinal: 1 },
      { line: 0, ordinal: 2 }
    ])
  })

  it('matches whatever the case of the ASCII the file happens to use', async () => {
    // #given a log that shouts its levels
    const text = 'ERROR failed\nerror failed again\nErRoR once more\n'

    // #when
    const found = await search(text, { query: 'error' })

    // #then — case-insensitive like the note find bar, so a log dump is
    // searchable without knowing how the writer capitalised it
    expect(found.hits).toEqual([
      { line: 0, ordinal: 0 },
      { line: 1, ordinal: 0 },
      { line: 2, ordinal: 0 }
    ])
  })

  it('folds only ASCII, so a multi-byte character is never half-folded', async () => {
    // #given accented text
    const text = 'é\nÉ\n'

    // #when
    const found = await search(text, { query: 'é' })

    // #then — case folding is ASCII-only on purpose: full Unicode folding
    // changes byte lengths, which would move every offset the scan is counting.
    // The accented capital is a miss, and that is the documented trade.
    expect(found.hits).toEqual([{ line: 0, ordinal: 0 }])
  })

  it('numbers lines correctly when the newline lands on a window boundary', async () => {
    // #given four short lines and a window that ends on a newline
    const text = 'aa\nbb\nhit\ndd\n'

    // #when
    const found = await search(text, { query: 'hit', chunkBytes: 3 })

    // #then
    expect(found.hits).toEqual([{ line: 2, ordinal: 0 }])
  })

  it('counts a match on the last line of a file that has no trailing newline', async () => {
    // #given
    const text = 'first\nlast hit'

    // #when
    const found = await search(text, { query: 'hit' })

    // #then
    expect(found.hits).toEqual([{ line: 1, ordinal: 0 }])
  })

  it('stops collecting positions at the cap but keeps counting past it', async () => {
    // #given far more matches than any navigation list should hold
    const text = Array.from({ length: 50 }, (_, i) => `row ${i} hit`).join('\n')

    // #when
    const found = await search(text, { query: 'hit', maxHits: 5 })

    // #then — a 2 GB file can hold millions of matches; the positions are
    // bounded, the count is not, and `limited` is what stops the UI from
    // showing a bounded list as if it were all of them
    expect(found.hits).toHaveLength(5)
    expect(found.total).toBe(50)
    expect(found.limited).toBe(true)
  })

  it('reports progress as it goes, never past the file and never past the total', async () => {
    // #given a file several windows long
    const text = Array.from({ length: 40 }, () => 'hit').join('\n') + '\n'
    const progress: Array<{ bytes: number; total: number }> = []

    // #when
    const found = await search(text, {
      query: 'hit',
      chunkBytes: 8,
      onProgress: (bytes, total) => progress.push({ bytes, total })
    })

    // #then — the count arrives in pieces, so the UI can say "so far" honestly
    // instead of rendering a partial count as a final one
    expect(progress.length).toBeGreaterThan(1)
    expect(progress.at(-1)?.bytes).toBe(Buffer.byteLength(text))
    expect(progress.at(-1)?.total).toBe(found.total)
    for (const step of progress) {
      expect(step.bytes).toBeLessThanOrEqual(Buffer.byteLength(text))
      expect(step.total).toBeLessThanOrEqual(found.total)
    }
  })

  it('gives up mid-file when asked to stop', async () => {
    // #given a file and a caller that changes its mind after the first window
    const text = Array.from({ length: 40 }, () => 'hit').join('\n') + '\n'
    let windows = 0

    // #when
    const found = await search(text, {
      query: 'hit',
      chunkBytes: 8,
      shouldStop: () => windows++ > 0
    })

    // #then — a superseded query must not keep reading a 2 GB file
    expect(found.cancelled).toBe(true)
    expect(found.bytesSearched).toBeLessThan(Buffer.byteLength(text))
  })

  it('reads windows rather than the file', async () => {
    // #given a reader that refuses any window bigger than it was told
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} hit`).join('\n')
    const bytes = Buffer.from(text, 'utf8')
    let largestWindow = 0
    const read: ByteReader = async (buffer, position) => {
      largestWindow = Math.max(largestWindow, buffer.length)
      if (position >= bytes.length) return 0
      const end = Math.min(position + buffer.length, bytes.length)
      bytes.copy(buffer, 0, position, end)
      return end - position
    }

    // #when
    const found = await findMatches(read, { query: 'hit', chunkBytes: 64 })

    // #then — above 512 MB there is no string that could hold the file, so a
    // search that assembles one does not work at the sizes this viewer opens
    expect(found.total).toBe(500)
    expect(largestWindow).toBeLessThanOrEqual(64)
  })

  it('finds nothing for an empty query, without reading a byte', async () => {
    // #given
    let reads = 0
    const read: ByteReader = async () => {
      reads += 1
      return 0
    }

    // #when
    const found = await findMatches(read, { query: '' })

    // #then
    expect(found.total).toBe(0)
    expect(reads).toBe(0)
  })

  it('finds nothing for a query that spans lines, which the viewer cannot show', async () => {
    // #given a pasted two-line query
    const text = 'one\ntwo\n'

    // #when
    const found = await search(text, { query: 'one\ntwo' })

    // #then — every hit is addressed as a line plus an occurrence on it, so a
    // match crossing a newline has no position the viewer could point at
    expect(found.total).toBe(0)
  })

  it('counts repeated overlapping text once per non-overlapping occurrence', async () => {
    // #given
    const text = 'aaaaa\n'

    // #when
    const found = await search(text, { query: 'aa', chunkBytes: 3 })

    // #then — non-overlapping, so the highlight in the viewer can segment the
    // line, and so a window boundary cannot change the answer
    expect(found.hits).toEqual([
      { line: 0, ordinal: 0 },
      { line: 0, ordinal: 1 }
    ])
  })
})
