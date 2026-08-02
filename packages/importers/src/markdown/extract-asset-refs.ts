/**
 * Extract relative asset references from a markdown body.
 *
 * Matches `![alt](ref)` and `[text](ref)`, plus Obsidian's embed syntax
 * `![[ref]]`, where ref:
 *   - is NOT a URL (no scheme like http://)
 *   - is NOT an absolute path (no leading /)
 *   - is NOT a wikilink ([[...]])
 *
 * Returns deduplicated list of relative path strings.
 */

// Matches markdown image/link syntax: ![...](ref) or [...](ref). Both inner
// classes also exclude `[` so a run cannot overrun across repeated `[…](`
// anchors (ReDoS hardening); valid link text / targets never contain `[`.
const MD_LINK_RE = /!?\[[^\][]*\]\(([^)[]+)\)/g

/**
 * Obsidian embeds the asset inside the brackets instead of after them:
 * `![[photo.png]]`, `![[photo.png|300x200]]` (display size), `![[photo.png|My
 * photo]]` (alias), `![[report.pdf#page=3]]` (anchor). The target stops at the
 * first `|` or `#`; `[`/`]` are excluded from both classes so a run cannot
 * overrun the closing `]]` into a later embed.
 *
 * The leading `!` is required — a bare `[[Note]]` is a link between notes, not
 * an embed, and stays a link.
 */
const WIKI_EMBED_RE = /!\[\[([^\][|#]+)(?:[|#][^\][]*)?\]\]/g

const URL_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
const WIKILINK_RE = /^\[\[/

/**
 * An embed points at an asset only when it names a file with an extension that
 * is not another note: `![[Some Note]]` and `![[Some Note.md]]` transclude a
 * note, and copying either in would duplicate the note as a file attachment.
 * Markdown-syntax refs need no such test — they carry a real path already.
 */
const EMBEDDABLE_REF_RE = /\.(?!md$|markdown$)[^./\\]+$/i

export function extractAssetRefs(body: string): string[] {
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  MD_LINK_RE.lastIndex = 0
  while ((match = MD_LINK_RE.exec(body)) !== null) {
    const ref = match[1].trim()
    if (!ref) continue
    if (URL_RE.test(ref)) continue
    if (WIKILINK_RE.test(ref)) continue
    if (ref.startsWith('/')) continue
    seen.add(ref)
  }

  WIKI_EMBED_RE.lastIndex = 0
  while ((match = WIKI_EMBED_RE.exec(body)) !== null) {
    const ref = match[1].trim()
    if (!ref) continue
    if (URL_RE.test(ref)) continue
    if (ref.startsWith('/')) continue
    if (!EMBEDDABLE_REF_RE.test(ref)) continue
    seen.add(ref)
  }

  return Array.from(seen)
}
