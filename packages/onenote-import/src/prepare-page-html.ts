/**
 * Pure string-level normalization of Microsoft Graph OneNote page HTML, run
 * BEFORE the desktop importer parses it with jsdom and the shared
 * HTML→markdown converter.
 *
 * The Graph API returns slightly non-conformant HTML that trips up DOM parsers
 * and the markdown walker:
 *   - `<object>` / `<iframe>` come back self-closed (`<object .../>`), which
 *     leaves following siblings nested inside them once parsed.
 *   - OneNote does not emit `<pre>`; code is styled `<p>`/`<span>` runs. We
 *     promote a clearly-fenced code marker so the shared converter's `<pre>`
 *     branch produces a real code fence.
 *   - Empty paragraph runs (`</p>\n  \n<p>`) become stray blank lines.
 *
 * These are deliberately conservative regex transforms — anything requiring a
 * real DOM (link rewriting, attachment extraction, MathML/ink) is left to the
 * desktop importer's jsdom pass and the shared converter.
 *
 * NOTE: MathML→LaTeX and InkML→SVG conversion are DEFERRED. OneNote emits math
 * as `<math>` (MathML) and handwriting as a separate InkML part; faithfully
 * converting them needs `mathml-to-latex` + an InkML→SVG renderer, neither of
 * which is wired up here. Such content currently passes through as plain text.
 *
 * @module onenote-import/prepare-page-html
 */

import type { PreparedPageHtml } from './types.ts'

/** `<object .../>` / `<iframe .../>` → paired open/close so children stay flat. */
const SELF_CLOSING_REGEX = /<(object|iframe)([^>]*?)\/>/gi

/** Collapse empty-paragraph runs and the `\n  \n` filler OneNote inserts. */
const EMPTY_PARAGRAPH_REGEX = /<p[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi

/**
 * Detect a `<pre>` (or a `<p>`/`<div>` whose `style` declares a monospace font)
 * and normalize it to a plain `<pre><code>…</code></pre>` so the shared
 * converter emits a fenced block. Only fires when the element clearly carries
 * code; ordinary prose is untouched.
 */
function normalizeCodeBlocks(html: string): string {
  // Already-<pre> blocks: ensure an inner <code> so the converter fences them.
  html = html.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (_m, attrs: string, inner: string) => {
    if (/<code\b/i.test(inner)) return `<pre${attrs}>${inner}</pre>`
    return `<pre${attrs}><code>${inner}</code></pre>`
  })

  // Monospace-styled <p>/<div> → <pre><code>…</code></pre>.
  html = html.replace(
    /<(p|div)\b([^>]*\bstyle="[^"]*font-family:[^"]*(?:Consolas|Courier|monospace)[^"]*"[^>]*)>([\s\S]*?)<\/\1>/gi,
    (_m, _tag: string, _attrs: string, inner: string) => `<pre><code>${inner}</code></pre>`
  )

  return html
}

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

  // 3. Promote code runs to real <pre><code> blocks.
  out = normalizeCodeBlocks(out)

  return { html: out }
}
