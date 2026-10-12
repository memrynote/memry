/**
 * CommonMark fence tracking, so a marker quoted inside a code block stays text.
 *
 * A boolean flipped by /^(?:```|~~~)/ is wrong in the way that matters here: it
 * tracks neither the fence character nor its length, so a ```` ```` ```` block
 * quoting an inner ``` — the shape of any note that documents one of Memry's
 * marker formats — reads as closed halfway through. The example marker inside
 * it then parses as a real block and write-back rewrites the file around it.
 *
 * A fence opens with 3+ of ` or ~ (up to 3 leading spaces) and closes only on
 * the SAME character, at least as long, with nothing after it.
 *
 * Moved here from `blocknote-converter.ts` when the toggle splitter in
 * `@memry/editor-schema/blocks` needed the same rule: two hand-copied trackers
 * are exactly the drift that turns one process's toggle into the other
 * process's code block.
 */
export interface MarkdownFenceTracker {
  /** True when `line` is inside a fence — the opening/closing lines included. */
  consume: (line: string) => boolean
}

export function createFenceTracker(): MarkdownFenceTracker {
  let open: { char: string; length: number } | null = null

  return {
    consume: (line) => {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!match) return open !== null

      const char = match[1][0]
      const length = match[1].length
      if (open === null) {
        // An info string may not contain a backtick (CommonMark 4.5).
        if (char === '`' && match[2].includes('`')) return false
        open = { char, length }
        return true
      }
      if (char === open.char && length >= open.length && match[2].trim() === '') {
        open = null
      }
      return true
    }
  }
}
