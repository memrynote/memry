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
  const scanner = createFenceScanner()
  return { consume: (line) => scanner.consume(line).inFence }
}

/**
 * Every fence's info string, in document order, `''` for an untagged fence.
 *
 * The parser invents `javascript` for a fence that carries no language, which
 * is how a shell block in a stranger's file came back claiming to be
 * JavaScript, and how an Obsidian Kanban board's settings block stopped
 * parsing (#1909). The source is the only place that knows the fence was bare,
 * so it is read here and matched against the parsed code blocks.
 */
export function listCodeFenceInfoStrings(markdown: string): string[] {
  const scanner = createFenceScanner()
  const infos: string[] = []
  for (const line of markdown.split('\n')) {
    const info = scanner.consume(line).opened
    if (info !== null) infos.push(info)
  }
  return infos
}

interface FenceLineResult {
  inFence: boolean
  /** The info string when this line OPENED a fence, `null` otherwise. */
  opened: string | null
}

function createFenceScanner(): { consume: (line: string) => FenceLineResult } {
  let open: { char: string; length: number } | null = null

  return {
    consume: (line) => {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (!match) return { inFence: open !== null, opened: null }

      const char = match[1][0]
      const length = match[1].length
      if (open === null) {
        // An info string may not contain a backtick (CommonMark 4.5).
        if (char === '`' && match[2].includes('`')) return { inFence: false, opened: null }
        open = { char, length }
        return { inFence: true, opened: match[2].trim() }
      }
      if (char === open.char && length >= open.length && match[2].trim() === '') {
        open = null
      }
      return { inFence: true, opened: null }
    }
  }
}
