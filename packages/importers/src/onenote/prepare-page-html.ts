/**
 * Pure string-level normalization of Microsoft Graph OneNote page HTML, run
 * BEFORE the desktop importer parses it with jsdom and the shared
 * HTML→markdown converter.
 *
 * The Graph API returns slightly non-conformant HTML that trips up DOM parsers
 * and the markdown walker:
 *   - `<object>` / `<iframe>` come back self-closed (`<object .../>`), which
 *     leaves following siblings nested inside them once parsed.
 *   - Empty paragraph runs (`</p>\n  \n<p>`) become stray blank lines.
 *
 * These are deliberately conservative regex transforms — anything requiring a
 * real DOM (code-run detection, tag conversion, attachment extraction,
 * MathML/ink) lives in the desktop importer's jsdom pass.
 *
 * @module onenote/prepare-page-html
 */

import type { PreparedPageHtml } from './types.ts'

/** `<object .../>` / `<iframe .../>` → paired open/close so children stay flat.
 * Attr run also excludes `<` so it cannot overrun across repeated tag-open
 * anchors (ReDoS); a self-closing tag's attributes never contain `<`/`>`. */
const SELF_CLOSING_REGEX = /<(object|iframe)([^><]*)\/>/gi

/** Collapse empty-paragraph runs and the `\n  \n` filler OneNote inserts.
 * Paragraphs carrying a `data-tag` are exempt: an unfilled checklist row is
 * empty but still has to import as a task. */
const EMPTY_PARAGRAPH_REGEX = /<p(?![^>]*\bdata-tag=)[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi

/**
 * Apply the pre-jsdom normalization pass to a Graph OneNote page HTML string.
 *
 * @param html - Raw `text/html` body returned from `/pages/{id}/content`.
 * @returns Normalized HTML ready for jsdom + the shared converter.
 */
export function preparePageHtml(html: string): PreparedPageHtml {
  let out = html

  // 1. Fix self-closing object/iframe tags.
  out = out.replace(SELF_CLOSING_REGEX, '<$1$2></$1>')

  // 2. Drop empty paragraphs / blank-line filler.
  out = out.replace(EMPTY_PARAGRAPH_REGEX, '')
  out = out.replace(/\n[ \t]+\n/g, '\n')

  return { html: out }
}
