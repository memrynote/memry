/**
 * Line-offset index and windowed line reads for the large-file viewer.
 *
 * Nothing here ever holds the file. V8 caps a string at 536 870 888 chars, so a
 * 512 MB file cannot be one JS string and a 2 GB file is not close — the viewer
 * reads fixed windows through a file handle at byte offsets instead, and the
 * only whole-file pass is this newline scan, which reads the same fixed window
 * and keeps a *sparse* table of line starts.
 *
 * Sparse is what makes 2 GB affordable. A dense table of 25 M line offsets is
 * 200 MB of Float64Array; keeping every `stride`-th offset and widening the
 * stride whenever the table fills caps it at `LINE_INDEX_MAX_CHECKPOINTS`
 * entries — 512 KB — for any file size. Reading line L then costs one seek to
 * checkpoint `floor(L / stride)` plus a short forward scan.
 */

import type { FileHandle } from 'fs/promises'

/** Window the whole-file newline scan reads at a time. */
export const SCAN_CHUNK_BYTES = 4 * 1024 * 1024

/** Window a line read reads at a time. Smaller: reads are latency-sensitive. */
export const READ_CHUNK_BYTES = 256 * 1024

/**
 * Hard cap on stored line offsets. 65 536 Float64 entries = 512 KB, whatever
 * the file size; the stride doubles instead of the table growing.
 */
export const LINE_INDEX_MAX_CHECKPOINTS = 65_536

/**
 * Longest single line handed to the renderer. Minified JSON is one line for the
 * whole file, and returning it whole would put the file back in one string —
 * exactly what this module exists to avoid. Over-long lines come back cut, and
 * cut lines are reported so the viewer can say so.
 */
export const MAX_LINE_BYTES = 64 * 1024

const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

export interface LineIndex {
  /** Byte offset of the first byte of line `i * stride`. */
  checkpoints: Float64Array
  stride: number
  lineCount: number
  /** Bytes actually scanned, which is what progress was reported against. */
  fileBytes: number
}

/**
 * Reads up to `buffer.length` bytes starting at `position`, returning how many
 * landed. Zero means end of file. One signature over a file handle in
 * production and over a buffer in tests, so the same code paths run at window
 * sizes no fixture would justify.
 */
export type ByteReader = (buffer: Buffer, position: number) => Promise<number>

export function fileHandleReader(handle: FileHandle): ByteReader {
  return async (buffer, position) => {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    return bytesRead
  }
}

export interface ScanLineIndexOptions {
  /** Size from `stat`, used only to bound the loop; the scan trusts the reader. */
  fileBytes: number
  chunkBytes?: number
  maxCheckpoints?: number
  onProgress?: (bytesScanned: number) => void
}

/**
 * One streaming pass over the file, building the sparse line-start table.
 *
 * Every `await read(...)` is a yield point, so this never occupies a thread for
 * longer than one window even when it runs in-process as the worker fallback.
 */
export async function scanLineIndex(
  read: ByteReader,
  options: ScanLineIndexOptions
): Promise<LineIndex> {
  const chunkBytes = options.chunkBytes ?? SCAN_CHUNK_BYTES
  const maxCheckpoints = options.maxCheckpoints ?? LINE_INDEX_MAX_CHECKPOINTS

  // Line 0 always starts at 0, so the table is never empty while scanning.
  const checkpoints: number[] = [0]
  let stride = 1
  let newlines = 0
  let lastByte = -1
  let position = 0

  const buffer = Buffer.allocUnsafe(chunkBytes)

  for (;;) {
    const bytesRead = await read(buffer, position)
    if (bytesRead <= 0) break
    const chunk = buffer.subarray(0, bytesRead)

    let from = 0
    for (;;) {
      const nl = chunk.indexOf(NEWLINE, from)
      if (nl < 0) break
      newlines += 1
      if (newlines % stride === 0) {
        checkpoints.push(position + nl + 1)
        if (checkpoints.length > maxCheckpoints) {
          // Keep every second entry and double the stride: entry `i` addressed
          // line `i * stride`, so entry `2i` addresses line `i * (2 * stride)`.
          let write = 1
          for (let readAt = 2; readAt < checkpoints.length; readAt += 2) {
            checkpoints[write++] = checkpoints[readAt]
          }
          checkpoints.length = write
          stride *= 2
        }
      }
      from = nl + 1
    }

    lastByte = chunk[bytesRead - 1]
    position += bytesRead
    options.onProgress?.(position)
  }

  // A trailing newline closes the last line rather than opening an empty one:
  // "a\nb\n" is two lines, which is what every text editor also says.
  const lineCount = position === 0 ? 0 : lastByte === NEWLINE ? newlines : newlines + 1

  // The last checkpoint can address a line the trailing newline never opened.
  let count = checkpoints.length
  while (count > 0 && (count - 1) * stride >= lineCount) count -= 1

  return {
    checkpoints: Float64Array.from(checkpoints.slice(0, count)),
    stride,
    lineCount,
    fileBytes: position
  }
}

export interface ReadLinesOptions {
  chunkBytes?: number
  maxLineBytes?: number
}

export interface ReadLinesResult {
  startLine: number
  lines: string[]
  /** Absolute line numbers cut at `maxLineBytes`. */
  truncated: number[]
}

/**
 * Read `count` lines starting at `startLine`, seeking through the index.
 *
 * The reader owns the byte→string boundary. Windows are cut at whatever offset
 * the loop reaches, so a multi-byte character can straddle two of them; a line
 * is only decoded once its bytes are complete, which is why partial windows are
 * buffered rather than decoded eagerly.
 */
export async function readLines(
  read: ByteReader,
  index: LineIndex,
  startLine: number,
  count: number,
  options: ReadLinesOptions = {}
): Promise<ReadLinesResult> {
  const chunkBytes = options.chunkBytes ?? READ_CHUNK_BYTES
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES

  const lines: string[] = []
  const truncated: number[] = []
  const result = (): ReadLinesResult => ({ startLine, lines, truncated })

  if (count <= 0 || startLine < 0 || startLine >= index.lineCount) return result()
  if (index.checkpoints.length === 0) return result()

  const checkpoint = Math.min(Math.floor(startLine / index.stride), index.checkpoints.length - 1)
  let position = index.checkpoints[checkpoint]
  let skip = startLine - checkpoint * index.stride

  let pending: Buffer[] = []
  let pendingBytes = 0
  let cut = false

  /** Buffer a line fragment, refusing to grow past the per-line cap. */
  const append = (segment: Buffer): void => {
    if (cut || segment.length === 0) return
    const room = maxLineBytes - pendingBytes
    if (segment.length >= room) {
      if (room > 0) {
        pending.push(Buffer.from(segment.subarray(0, room)))
        pendingBytes = maxLineBytes
      }
      cut = true
      return
    }
    // The read buffer is reused every window, so fragments must be copied.
    pending.push(Buffer.from(segment))
    pendingBytes += segment.length
  }

  /** Close the current line. Returns true once the window is full. */
  const endLine = (): boolean => {
    if (skip > 0) {
      skip -= 1
    } else {
      lines.push(decodeLine(pending, pendingBytes))
      if (cut) truncated.push(startLine + lines.length - 1)
    }
    pending = []
    pendingBytes = 0
    cut = false
    return lines.length >= count
  }

  const buffer = Buffer.allocUnsafe(chunkBytes)
  let atEnd = false

  while (lines.length < count && !atEnd) {
    const bytesRead = await read(buffer, position)
    if (bytesRead <= 0) {
      atEnd = true
      break
    }
    const chunk = buffer.subarray(0, bytesRead)

    let from = 0
    while (from < bytesRead) {
      const nl = chunk.indexOf(NEWLINE, from)
      if (nl < 0) {
        append(chunk.subarray(from))
        break
      }
      append(chunk.subarray(from, nl))
      from = nl + 1
      if (endLine()) return result()
    }

    position += bytesRead
  }

  // A file whose last line has no newline still ends in a line.
  if (lines.length < count && (pendingBytes > 0 || cut)) endLine()

  return result()
}

function decodeLine(parts: Buffer[], byteLength: number): string {
  const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, byteLength)
  // CRLF files would otherwise show a stray control character on every row.
  const end =
    buf.length > 0 && buf[buf.length - 1] === CARRIAGE_RETURN ? buf.length - 1 : buf.length
  return buf.toString('utf8', 0, end)
}
