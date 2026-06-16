/**
 * Inter-file wikilink resolution for multi-file HTML imports.
 *
 * Pure function — no I/O, no jsdom.
 */

import * as path from 'path'

/**
 * Attempt to resolve an anchor href to a wikilink title.
 *
 * If `href` (after percent-decoding) has a basename that matches the basename of
 * an imported HTML file, returns the title that file was given so the caller can
 * emit `[[title]]`.  Returns `null` when no match is found.
 *
 * @param href                   - The raw href attribute value from the anchor.
 * @param importedTitlesByBasename - Map of `<basename-without-ext>` → `<title>`.
 *                                  Keys are lower-cased for case-insensitive matching.
 */
export function interFileWikilink(
  href: string,
  importedTitlesByBasename: Map<string, string>
): string | null {
  // Percent-decode, drop any fragment / query string
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    decoded = href
  }

  // Strip fragment (#...) and query (?...)
  const clean = decoded.split('?')[0].split('#')[0]

  const basename = path.basename(clean)
  const ext = path.extname(basename).toLowerCase()
  const stem = ext ? basename.slice(0, -ext.length) : basename

  const title = importedTitlesByBasename.get(stem.toLowerCase())
  return title ?? null
}
