import { createFenceTracker } from './markdown-fences.ts'

/**
 * Markdown with every fenced code block and inline code span blanked out, so a
 * scan for `[[…]]` reads only text that renders as a link (AF-006). A note that
 * documents link syntax in backticks drew an unresolved node on the graph.
 *
 * HTML comments are kept as written, code-looking text inside them included:
 * a link hidden in a comment is a real link. A comment that opens before a
 * backtick also wins over it, the way CommonMark reads whichever construct
 * starts first, so a stray backtick in a comment cannot pair with one outside.
 *
 * A code span is matched within one line. A span broken across lines in one
 * paragraph is valid CommonMark but rare in notes, and a per-line match cannot
 * blank a run of lines because one backtick was left unclosed.
 */
export function blankMarkdownCode(markdown: string): string {
  if (!markdown.includes('`') && !markdown.includes('~~~')) return markdown

  const fence = createFenceTracker()
  let inComment = false

  return markdown
    .split('\n')
    .map((line) => {
      if (inComment) {
        const close = line.indexOf('-->')
        if (close === -1) return line
        inComment = false
        const end = close + 3
        return line.slice(0, end) + blankLine(line.slice(end))
      }
      // The fence pattern cannot match past a CRLF note's trailing `\r`.
      if (fence.consume(line.endsWith('\r') ? line.slice(0, -1) : line)) return ''
      return blankLine(line)
    })
    .join('\n')

  function blankLine(line: string): string {
    let out = ''
    let i = 0
    while (i < line.length) {
      const tick = line.indexOf('`', i)
      const comment = line.indexOf('<!--', i)
      if (tick === -1 && comment === -1) break

      if (comment !== -1 && (tick === -1 || comment < tick)) {
        const close = line.indexOf('-->', comment + 4)
        if (close === -1) {
          inComment = true
          return out + line.slice(i)
        }
        out += line.slice(i, close + 3)
        i = close + 3
        continue
      }

      let runEnd = tick
      while (line[runEnd] === '`') runEnd++
      const closeAt = findClosingRun(line, runEnd, runEnd - tick)
      if (closeAt === -1) {
        out += line.slice(i, runEnd)
        i = runEnd
        continue
      }
      out += line.slice(i, tick) + ' '
      i = closeAt + (runEnd - tick)
    }
    return out + line.slice(i)
  }
}

/** Start of the next backtick run exactly `length` long, or -1. */
function findClosingRun(line: string, from: number, length: number): number {
  let i = from
  while (i < line.length) {
    const start = line.indexOf('`', i)
    if (start === -1) return -1
    let end = start
    while (line[end] === '`') end++
    if (end - start === length) return start
    i = end
  }
  return -1
}
