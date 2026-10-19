/** The first non-blank line is the title; whatever follows it is the body. */
export function splitStickyText(text: string): { firstLine: string; rest: string } {
  const trimmed = text.trim()
  const breakAt = trimmed.indexOf('\n')
  if (breakAt === -1) return { firstLine: trimmed, rest: '' }
  return { firstLine: trimmed.slice(0, breakAt).trim(), rest: trimmed.slice(breakAt + 1).trim() }
}
