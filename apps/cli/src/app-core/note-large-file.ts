import { createReadStream } from 'node:fs'

/** Per-line cap, like desktop's large-file viewer (64 KB). */
export const MAX_LINE_CHARS = 64 * 1024

/**
 * Lines of a file, streamed so a multi-hundred-MB log never sits in memory
 * whole. Splits on `\n` only (a trailing `\r` is dropped), the way desktop's
 * line index counts, so line numbers agree with the app's large-file viewer.
 */
export async function* iterateFileLines(absolutePath: string): AsyncGenerator<string> {
  const stream = createReadStream(absolutePath, { encoding: 'utf8' })
  let pending = ''
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        yield line.endsWith('\r') ? line.slice(0, -1) : line
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    }
    // A file that ends without a newline still has a last line; one that ends
    // with a newline does not gain an empty one.
    if (pending.length > 0) yield pending.endsWith('\r') ? pending.slice(0, -1) : pending
  } finally {
    stream.destroy()
  }
}
