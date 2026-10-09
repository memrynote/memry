/**
 * Extract inline #tag patterns from markdown body text.
 * Strips code blocks and inline code first, then matches tags
 * preceded by whitespace or start-of-string.
 *
 * Mirrors the editor's HASH_TAG_PATTERN from hash-tag.tsx.
 *
 * @param content - Markdown body (post-frontmatter)
 * @returns Deduplicated tag names (case preserved, case-insensitive dedupe)
 */
export function extractInlineTagsFromMarkdown(content: string): string[] {
  const withoutCode = content.replace(/```[\s\S]*?```/g, '')
  const withoutInlineCode = withoutCode.replace(/`[^`]+`/g, '')

  const byKey = new Map<string, string>()
  const pattern = /#([a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(withoutInlineCode)) !== null) {
    const precedingChar = match.index > 0 ? withoutInlineCode[match.index - 1] : ''
    if (precedingChar && !/\s/.test(precedingChar)) continue
    const key = match[1].toLowerCase()
    if (!byKey.has(key)) byKey.set(key, match[1])
  }

  return Array.from(byKey.values())
}

/** A tag rename: `from` and every `from/…` child take `to` as their prefix. */
export interface TagRename {
  from: string
  to: string
}

/**
 * The name `tag` takes under `renames`, or null when no rename names it or a
 * parent of it. Whole tags only: renaming `person` leaves `personal` alone.
 * A child keeps the spelling of its own suffix (`Person/VIP` → `people/VIP`).
 */
export function renamedTag(tag: string, renames: readonly TagRename[]): string | null {
  const key = tag.toLowerCase()
  for (const { from, to } of renames) {
    const fromKey = from.trim().toLowerCase()
    if (key === fromKey) return to.trim()
    if (key.startsWith(`${fromKey}/`)) return to.trim() + tag.slice(fromKey.length)
  }
  return null
}

const CODE_PATTERN = /```[\s\S]*?```|`[^`]+`/g
const INLINE_TAG_PATTERN = /#([a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g

/**
 * `content` with every inline `#tag` that `renames` names rewritten, read with
 * the grammar `extractInlineTagsFromMarkdown` indexes: code blocks and inline
 * code stay byte for byte, and a `#` must start the text or follow whitespace.
 */
export function rewriteInlineTagsInMarkdown(
  content: string,
  renames: readonly TagRename[]
): string {
  let out = ''
  let last = 0
  // The extractor drops code before it matches, so the character before a
  // `#` right after a code span is whatever preceded the span.
  let before = ''
  const rewritePlain = (text: string): string =>
    text.replace(INLINE_TAG_PATTERN, (whole: string, tag: string, offset: number) => {
      const preceding = offset > 0 ? text[offset - 1] : before
      if (preceding && !/\s/.test(preceding)) return whole
      const next = renamedTag(tag, renames)
      return next === null ? whole : `#${next}`
    })
  for (const match of content.matchAll(CODE_PATTERN)) {
    const plain = content.slice(last, match.index)
    out += rewritePlain(plain) + match[0]
    if (plain) before = plain[plain.length - 1]
    last = match.index + match[0].length
  }
  return out + rewritePlain(content.slice(last))
}
