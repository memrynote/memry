/**
 * Extract relative asset references from a markdown body.
 *
 * Matches `![alt](ref)` and `[text](ref)` where ref:
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

const URL_RE = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
const WIKILINK_RE = /^\[\[/

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
  return Array.from(seen)
}
