/**
 * The byte-exact frontmatter splitter, shared by every surface that has to
 * decide where a note's body starts.
 *
 * It lives here rather than in `@memry/app-core` because the WebView editor
 * bundle needs it too (chapter 12 §12.1, T124): the guest is handed a note's
 * create-time `content` VERBATIM and splits it itself, so the Rust core does no
 * markdown handling at all, frontmatter included. `@memry/app-core/markdown`
 * pulls in gray-matter, which is Node-only, and a second splitter in the bundle
 * would be a second answer to "where does the body start" — the one thing
 * chapter 12 §12.4.1's byte-exactness argument cannot survive.
 *
 * This module therefore has NO dependencies. Parsing the block's YAML is still
 * app-core's job; deciding where it ends is this file's.
 */

export interface FrontmatterSplit {
  /**
   * Exact original substring from byte 0 (BOM included) through the closing
   * `---` line and its EOL, or null when the file has no frontmatter.
   * `block + body === raw` always holds, byte-exact.
   */
  block: string | null
  body: string
}

/**
 * Slice the raw frontmatter block ourselves (same `---` delimiters gray-matter
 * uses) so re-emitting it is byte-exact by construction — comments, key order,
 * quoting, CR bytes and BOM all survive. An unclosed block is not frontmatter.
 */
export function splitFrontmatterBlock(raw: string): FrontmatterSplit {
  const bom = raw.charCodeAt(0) === 0xfeff ? 1 : 0
  const rest = bom ? raw.slice(1) : raw
  const firstNl = rest.indexOf('\n')
  if (firstNl === -1) return { block: null, body: raw }
  if (rest.slice(0, firstNl).replace(/\r$/, '') !== '---') return { block: null, body: raw }

  let from = firstNl + 1
  while (from <= rest.length) {
    const nl = rest.indexOf('\n', from)
    const lineEnd = nl === -1 ? rest.length : nl
    if (rest.slice(from, lineEnd).replace(/\r$/, '') === '---') {
      const blockEnd = nl === -1 ? rest.length : nl + 1
      return { block: raw.slice(0, bom + blockEnd), body: rest.slice(blockEnd) }
    }
    if (nl === -1) break
    from = nl + 1
  }
  return { block: null, body: raw }
}
