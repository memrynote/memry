/**
 * Streaming measurement of a markdown file.
 *
 * Nothing here ever holds the file as one string. `readFile(…, 'utf-8')` throws
 * `ERR_STRING_TOO_LONG` above V8's 536 870 888-character ceiling, and well
 * before that a single allocation of a few hundred megabytes is a main-process
 * GC pause on its own. A vault file can be either, so the counts, the hash and
 * the indexed head are all built chunk by chunk.
 *
 * @module vault/file-scan
 */

import { createReadStream } from 'fs'
import { createContentHasher } from './frontmatter'

/** Bytes pulled from disk per chunk. The stream decodes UTF-8 across them. */
const READ_CHUNK_BYTES = 64 * 1024

/** How much of a file is kept for the snippet and the search index. */
export const DEFAULT_HEAD_CHARS = 256 * 1024

export interface MarkdownFileScan {
  /** Whitespace-delimited tokens across the whole file. */
  wordCount: number
  characterCount: number
  /** Identical to `generateContentHash` over the same bytes. */
  contentHash: string
  /** The first `headChars` characters, at most. */
  head: string
}

function isWhitespace(code: number): boolean {
  // space, tab, LF, CR, form feed, vertical tab
  return code === 0x20 || (code >= 0x09 && code <= 0x0d)
}

/**
 * Read a file in chunks, measuring it as it goes.
 *
 * @returns null when the file is gone — the backfill queue can outlive a file
 *   the user deletes a moment after pasting it.
 */
export async function scanMarkdownFile(
  absolutePath: string,
  headChars: number = DEFAULT_HEAD_CHARS
): Promise<MarkdownFileScan | null> {
  const hasher = createContentHasher()
  let wordCount = 0
  let characterCount = 0
  let head = ''
  // Carried across chunks so a word split by a chunk boundary is counted once.
  let previousWasWhitespace = true

  const stream = createReadStream(absolutePath, {
    encoding: 'utf-8',
    highWaterMark: READ_CHUNK_BYTES
  })

  try {
    for await (const chunk of stream) {
      const text = chunk as string
      hasher.update(text)
      characterCount += text.length

      if (head.length < headChars) {
        head += text.slice(0, headChars - head.length)
      }

      for (let i = 0; i < text.length; i++) {
        const whitespace = isWhitespace(text.charCodeAt(i))
        if (previousWasWhitespace && !whitespace) wordCount++
        previousWasWhitespace = whitespace
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
    throw error
  }

  return { wordCount, characterCount, contentHash: hasher.digest(), head }
}
