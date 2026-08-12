/**
 * NotePlan hashtags, including the hierarchical `#books/decisive` form.
 *
 * Mirrors `bear/parse-tags.ts` minus Bear's `#[enclosed tag]#` syntax, which
 * NotePlan does not have. Pure — no fs access.
 */

const FENCE_RE = /^\s*(```|~~~)/
const HEADING_RE = /^#{1,6}\s/
// `(?<!\S)` anchors the tag to a word boundary so `no#42` is not a tag. The
// character class carries `/` so hierarchical tags stay whole.
const TAG_RE = /(?<!\S)#([\p{L}\p{N}/\-_]+)/gu

export function parseTags(body: string): string[] {
  const seen = new Set<string>()
  let inFence = false

  for (const line of body.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    // A markdown heading opens with `#` + space; a tag never does.
    if (HEADING_RE.test(line.trimStart())) continue

    for (const match of line.matchAll(TAG_RE)) {
      const tag = match[1]
      if (tag) seen.add(tag)
    }
  }

  return Array.from(seen).sort()
}
