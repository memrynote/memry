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
