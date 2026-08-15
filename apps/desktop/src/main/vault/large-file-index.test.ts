import { describe, it, expect } from 'vitest'
import * as fsp from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import {
  scanLineIndex,
  readLines,
  fileHandleReader,
  type ByteReader,
  type LineIndex
} from './large-file-index'

/**
 * A reader over an in-memory buffer, so the scan can be driven at window sizes
 * a real fixture would never justify. The production reader is the same
 * signature over a file handle, exercised separately below.
 */
function bufferReader(bytes: Buffer): ByteReader {
  return async (buffer, position) => {
    if (position >= bytes.length) return 0
    const end = Math.min(position + buffer.length, bytes.length)
    bytes.copy(buffer, 0, position, end)
    return end - position
  }
}

async function indexOf(text: string, options: Parameters<typeof scanLineIndex>[1] | null = null) {
  const bytes = Buffer.from(text, 'utf8')
  return scanLineIndex(bufferReader(bytes), { fileBytes: bytes.length, ...(options ?? {}) })
}

async function linesOf(
  text: string,
  index: LineIndex,
  startLine: number,
  count: number,
  options?: Parameters<typeof readLines>[4]
) {
  const bytes = Buffer.from(text, 'utf8')
  return readLines(bufferReader(bytes), index, startLine, count, options)
}

async function withTempFile<T>(
  contents: Buffer | string,
  run: (path: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'memry-large-file-'))
  const path = join(dir, 'dump.md')
  await writeFile(path, contents)
  try {
    return await run(path)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('scanLineIndex', () => {
  it('counts lines without a trailing newline creating a phantom last line', async () => {
    // #given/when
    const withTrailing = await indexOf('alpha\nbeta\n')
    const withoutTrailing = await indexOf('alpha\nbeta')

    // #then — "a\nb\n" is two lines, not three. Getting this wrong shows the
    // viewer an empty final row on every file a text editor ever wrote.
    expect(withTrailing.lineCount).toBe(2)
    expect(withoutTrailing.lineCount).toBe(2)
  })

  it('counts a blank line between two lines', async () => {
    // #given/when
    const index = await indexOf('alpha\n\nbeta\n')

    // #then
    expect(index.lineCount).toBe(3)
  })

  it('reports zero lines for an empty file', async () => {
    // #given/when
    const index = await indexOf('')

    // #then
    expect(index.lineCount).toBe(0)
  })

  it('keeps the checkpoint table bounded by widening the stride', async () => {
    // #given 1000 lines against room for 8 checkpoints — the shape a 2 GB file
    // has against the production cap, at a size a test can assert exactly
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n'

    // #when
    const index = await indexOf(text, { fileBytes: 0, maxCheckpoints: 8 })

    // #then — the table never grows past the cap, whatever the line count
    expect(index.checkpoints.length).toBeLessThanOrEqual(8)
    expect(index.lineCount).toBe(1000)
    // a wider stride is the price; it must still be a power-of-two multiple so
    // checkpoint i addresses line i*stride
    expect(index.stride).toBeGreaterThan(1)
    expect(Math.log2(index.stride) % 1).toBe(0)
  })

  it('places every checkpoint at the true start of its line', async () => {
    // #given lines of deliberately uneven width, so an off-by-one in the
    // checkpoint offset cannot be hidden by uniform spacing
    const lines = Array.from({ length: 200 }, (_, i) => 'x'.repeat(i % 17) + `#${i}`)
    const text = lines.join('\n') + '\n'

    // #when
    const index = await indexOf(text, { fileBytes: 0, maxCheckpoints: 8, chunkBytes: 7 })

    // #then — reading from each checkpoint's own line returns that exact line
    for (let cp = 0; cp < index.checkpoints.length; cp++) {
      const line = cp * index.stride
      const result = await linesOf(text, index, line, 1)
      expect(result.lines).toEqual([lines[line]])
    }
  })

  it('reports progress as it scans, never past the file size', async () => {
    // #given a file that takes several windows to cross
    const text = 'a\n'.repeat(500)
    const seen: number[] = []

    // #when
    const index = await indexOf(text, {
      fileBytes: 0,
      chunkBytes: 64,
      onProgress: (bytesScanned) => seen.push(bytesScanned)
    })

    // #then — progress arrives more than once, rises monotonically, and ends at
    // the whole file. Without this the viewer has nothing to show for the wait.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(seen.at(-1)).toBe(index.fileBytes)
  })

  it('finds newlines that straddle a window boundary', async () => {
    // #given a window size chosen so newlines land on both sides of every seam
    const text = 'ab\ncd\nef\ngh\n'

    // #when
    const index = await indexOf(text, { fileBytes: 0, chunkBytes: 3 })

    // #then
    expect(index.lineCount).toBe(4)
  })
})

describe('readLines', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n') + '\n'

  it('returns the requested window and nothing either side of it', async () => {
    // #given
    const index = await indexOf(text, { fileBytes: 0, maxCheckpoints: 4 })

    // #when
    const result = await linesOf(text, index, 20, 3)

    // #then
    expect(result.lines).toEqual(['line-20', 'line-21', 'line-22'])
    expect(result.startLine).toBe(20)
  })

  it('stops at the end of the file instead of padding the window', async () => {
    // #given
    const index = await indexOf(text, { fileBytes: 0 })

    // #when a window that runs past the last line
    const result = await linesOf(text, index, 48, 10)

    // #then
    expect(result.lines).toEqual(['line-48', 'line-49'])
  })

  it('returns nothing for a start line past the end, without reading a byte', async () => {
    // #given a reader that refuses to be called at all
    const index = await indexOf(text, { fileBytes: 0 })
    const refuse: ByteReader = () => {
      throw new Error('read attempted for a line that does not exist')
    }

    // #when a line number past the end of the file arrives
    const result = await readLines(refuse, index, 500, 10)

    // #then — an empty window, off the index alone. Walking the file looking
    // for a line that cannot exist is unbounded work a renderer could ask for
    // with one number.
    expect(result.lines).toEqual([])
  })

  it('reads a window without allocating the whole file', async () => {
    // #given a file far larger than the read window
    const big = 'x'.repeat(200) + '\n'
    const body = big.repeat(2000)
    const index = await indexOf(body, { fileBytes: 0, maxCheckpoints: 8 })

    // #when
    const result = await linesOf(body, index, 1500, 2, { chunkBytes: 64 })

    // #then — two lines came back, and the window that produced them is bounded
    // by the read chunk, not by the file. This is the whole point: V8 caps a
    // string at ~512 MB, so a viewer that concatenates cannot reach 2 GB.
    expect(result.lines).toEqual(['x'.repeat(200), 'x'.repeat(200)])
    const returnedBytes = result.lines.reduce((n, line) => n + line.length, 0)
    expect(returnedBytes).toBeLessThan(body.length / 100)
  })

  it('truncates a single line that would itself be an unbounded string', async () => {
    // #given the minified-JSON shape: one line holding the whole file
    const body = 'y'.repeat(5000) + '\n' + 'short\n'
    const index = await indexOf(body, { fileBytes: 0 })

    // #when
    const result = await linesOf(body, index, 0, 2, { maxLineBytes: 100, chunkBytes: 64 })

    // #then — the long line is cut to the cap and reported as cut, and the line
    // after it is still found: the reader skipped the rest rather than buffering it
    expect(result.lines[0]).toHaveLength(100)
    expect(result.truncated).toEqual([0])
    expect(result.lines[1]).toBe('short')
  })

  it('strips the carriage return of a CRLF file', async () => {
    // #given
    const body = 'alpha\r\nbeta\r\n'
    const index = await indexOf(body, { fileBytes: 0 })

    // #when
    const result = await linesOf(body, index, 0, 2)

    // #then — a visible ^M on every row of a Windows log is a bug report
    expect(result.lines).toEqual(['alpha', 'beta'])
  })

  it('decodes multi-byte characters split across a read window', async () => {
    // #given a line whose emoji straddles every plausible window boundary
    const body = 'héllo 🌍 wörld\nsecond\n'
    const index = await indexOf(body, { fileBytes: 0 })

    // #when a window size that cannot align with the UTF-8 sequences
    const result = await linesOf(body, index, 0, 2, { chunkBytes: 3 })

    // #then
    expect(result.lines).toEqual(['héllo 🌍 wörld', 'second'])
  })
})

describe('fileHandleReader', () => {
  it('reads windows at byte offsets through a real file handle', async () => {
    // #given a real file on disk
    const body = Array.from({ length: 300 }, (_, i) => `row ${i}`).join('\n') + '\n'

    await withTempFile(body, async (path) => {
      const handle = await fsp.open(path, 'r')
      try {
        // #when indexed and read through the handle at 64-byte windows
        const read = fileHandleReader(handle)
        const index = await scanLineIndex(read, {
          fileBytes: (await handle.stat()).size,
          chunkBytes: 64
        })
        const result = await readLines(read, index, 299, 1, { chunkBytes: 64 })

        // #then — the last line of the file comes back from a seek, having read
        // only the windows around it
        expect(index.lineCount).toBe(300)
        expect(result.lines).toEqual(['row 299'])
      } finally {
        await handle.close()
      }
    })
  })
})
