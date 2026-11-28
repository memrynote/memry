import { maskMarkdownCode } from '@memry/shared/markdown-code'

/**
 * `maskMarkdownCode` for a scan that has to read a code span as BlockNote's
 * inline parser does. `maskMarkdownCode` matches a span within one line, and
 * the parser closes it on the first run of the same length anywhere later in
 * its paragraph, a line break included, so `` `[](u\nv)` `` is code the scan
 * must not touch.
 *
 * What is left unmasked are the backtick runs no line closed. Within a
 * paragraph (the lines up to the next blank one) each takes the first later
 * run of its length, as `parseInlineCode` does, and the text between them,
 * line breaks kept, becomes blanks. A backslash before the run's first
 * backtick escapes it. One pass over the runs, a pointer for each length.
 */
export function maskCodeAcrossLines(markdown: string): string {
  const code = maskMarkdownCode(markdown)
  if (!code.includes('`') || !code.includes('\n')) return code
  const spans: Array<[number, number]> = []
  const lines = code.split('\n')
  let offset = 0
  let paragraph = 0
  const flush = (end: number): void => {
    if (end > paragraph) spansIn(code, paragraph, end, spans)
  }
  for (const line of lines) {
    if (line.trim() === '') {
      flush(offset)
      paragraph = offset + line.length + 1
    }
    offset += line.length + 1
  }
  flush(code.length)
  let out = ''
  let last = 0
  for (const [start, end] of spans) {
    out += code.slice(last, start) + code.slice(start, end).replace(/[^\n]/g, ' ')
    last = end
  }
  return out + code.slice(last)
}

/** The spans of `code[from, to)` that cross a line, pushed in order. */
function spansIn(code: string, from: number, to: number, spans: Array<[number, number]>): void {
  const runs: Array<{ start: number; length: number }> = []
  for (const run of code.slice(from, to).matchAll(/`+/g)) {
    runs.push({ start: from + run.index, length: run[0].length })
  }
  if (runs.length < 2) return
  const byLength = new Map<number, number[]>()
  runs.forEach((run, index) => {
    const same = byLength.get(run.length)
    if (same) same.push(index)
    else byLength.set(run.length, [index])
  })
  const pointer = new Map<number, number>()
  for (let k = 0; k < runs.length; k++) {
    let { start, length } = runs[k]
    if (isEscaped(code, start)) {
      start++
      length--
      if (length === 0) continue
    }
    const same = byLength.get(length)
    if (!same) continue
    let at = pointer.get(length) ?? 0
    while (at < same.length && same[at] <= k) at++
    pointer.set(length, at)
    if (at === same.length) continue
    const close = runs[same[at]]
    spans.push([start, close.start + close.length])
    k = same[at]
  }
}

/** Whether an odd number of backslashes sits right before `at`. */
function isEscaped(text: string, at: number): boolean {
  let slashes = 0
  while (at - slashes > 0 && text[at - slashes - 1] === '\\') slashes++
  return slashes % 2 === 1
}
