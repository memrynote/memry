import { htmlToMarkdown } from '../import/_shared/html-to-markdown'

const DROPPED_TAGS = new Set(['script', 'style', 'noscript'])

/**
 * A Reader document's `html_content` as markdown, through the converter the
 * importers share (D11). Images are dropped: a remote URL must not reach a note
 * (D14), and this unit has no downloader for them. The writer (#1412) can add
 * article images later by collecting them here.
 */
export async function readerFullText(html: string): Promise<string> {
  // Lazy: jsdom stays out of the main process startup set (see lazy-jsdom.ts).
  const { JSDOM } = await import('../import/_shared/lazy-jsdom')
  const { body } = new JSDOM(`<html><body>${html}</body></html>`).window.document
  return htmlToMarkdown(body, {
    image: () => '',
    skipBlock: (el) => DROPPED_TAGS.has(el.tagName.toLowerCase())
  }).markdown
}
