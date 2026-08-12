/**
 * NotePlan's real note title is the first `# H1` line of the body, not the
 * filename — `start-here.txt` opens as "Start Here". Wikilinks resolve by
 * title on both sides, so preserving this is what keeps `[[Start Here]]`
 * working after import.
 *
 * Pure — no fs access.
 */

const FENCE_RE = /^\s*(```|~~~)/
const H1_RE = /^#\s+(.+?)\s*$/

/** Index of the first H1 line outside any code fence, or -1. */
function headingLineIndex(lines: string[]): number {
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (H1_RE.test(lines[i])) return i
  }
  return -1
}

export function firstHeading(body: string): string | null {
  const lines = body.split('\n')
  const index = headingLineIndex(lines)
  if (index === -1) return null
  return H1_RE.exec(lines[index])![1]
}

/**
 * Drop the H1 line `firstHeading` found. The title moves onto the note itself,
 * so leaving it in the body would render it twice. Removes that exact line —
 * never a same-looking line inside a code fence.
 */
export function stripFirstHeading(body: string): string {
  const lines = body.split('\n')
  const index = headingLineIndex(lines)
  if (index === -1) return body
  lines.splice(index, 1)
  // A blank line left where the heading was would open the body with a gap.
  if (lines[index] === '') lines.splice(index, 1)
  return lines.join('\n')
}
