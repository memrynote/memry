import { foldTag } from './tag-fold'

/**
 * The inline `#tag` grammar every reader and rewriter of note bodies shares:
 * a letter, then letters, digits, `_` or `-`, with `/`-separated child
 * segments. Group 1 is the tag without its `#`.
 */
export const INLINE_TAG_PATTERN = /#([a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*)/g

const INLINE_TAG_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_-]*)*$/

/** Whether `name` can be written as an inline `#name` and read back whole. */
export function isInlineTagName(name: string): boolean {
  return INLINE_TAG_NAME.test(name)
}

/**
 * A `#` starts a tag only at the start of the text or after whitespace.
 * `preceding` is the character before the `#`, or `''` at the start.
 */
export function canStartInlineTag(preceding: string): boolean {
  return preceding === '' || /\s/.test(preceding)
}

export interface InlineTagMatch {
  /** Offset of the `#` in the text. */
  index: number
  /** The tag without its `#`. */
  tag: string
}

/**
 * The inline tags in code-free `text`. `before` is the character that
 * precedes the text, `''` at the start of the body.
 */
export function findInlineTags(text: string, before = ''): InlineTagMatch[] {
  const out: InlineTagMatch[] = []
  for (const match of text.matchAll(INLINE_TAG_PATTERN)) {
    const preceding = match.index > 0 ? text[match.index - 1] : before
    if (canStartInlineTag(preceding)) out.push({ index: match.index, tag: match[1] })
  }
  return out
}

/**
 * Extract inline #tag patterns from markdown body text.
 * Strips code blocks and inline code first, then matches tags
 * preceded by whitespace or start-of-string.
 *
 * @param content - Markdown body (post-frontmatter)
 * @returns Deduplicated tag names (case preserved, case-insensitive dedupe)
 */
export function extractInlineTagsFromMarkdown(content: string): string[] {
  const withoutCode = content.replace(/```[\s\S]*?```/g, '')
  const withoutInlineCode = withoutCode.replace(/`[^`]+`/g, '')

  const byKey = new Map<string, string>()
  for (const { tag } of findInlineTags(withoutInlineCode)) {
    const key = foldTag(tag)
    if (!byKey.has(key)) byKey.set(key, tag)
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
 * Names compare with `foldTag`, which keeps length, so the suffix is cut from
 * the original spelling at the length of `from`.
 */
export function renamedTag(tag: string, renames: readonly TagRename[]): string | null {
  const key = foldTag(tag)
  for (const { from, to } of renames) {
    const fromTrim = from.trim()
    const fromKey = foldTag(fromTrim)
    if (key === fromKey) return to.trim()
    if (key.startsWith(`${fromKey}/`)) return to.trim() + tag.slice(fromTrim.length)
  }
  return null
}

const CODE_PATTERN = /```[\s\S]*?```|`[^`]+`/g

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
  let before = ''
  const rewritePlain = (text: string): string => {
    let result = ''
    let at = 0
    for (const { index, tag } of findInlineTags(text, before)) {
      const next = renamedTag(tag, renames)
      if (next === null) continue
      result += `${text.slice(at, index)}#${next}`
      at = index + 1 + tag.length
    }
    return result + text.slice(at)
  }
  for (const match of content.matchAll(CODE_PATTERN)) {
    const plain = content.slice(last, match.index)
    out += rewritePlain(plain) + match[0]
    if (plain) before = plain[plain.length - 1]
    last = match.index + match[0].length
  }
  return out + rewritePlain(content.slice(last))
}
