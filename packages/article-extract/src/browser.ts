// Use the /full build: the default 'defuddle' browser build ships WITHOUT the
// markdown converter, so { markdown: true } is silently ignored and `content`
// stays HTML — which the markdown note editor can't render. /full bundles
// toMarkdown so `content` becomes markdown, matching the Node path.
import Defuddle from 'defuddle/full'
import { mapToArticleCapture, type ArticleCapture, type DefuddleLikeResult } from './map.ts'

// Browser counterpart to extractFromHtml: defuddle parses the LIVE DOM (higher
// fidelity than fetched HTML because computed styles are available), then we
// reuse the exact same mapping the Node path uses. `url` is passed so relative
// links/images in the markdown resolve to absolute URLs (as the Node path does).
export function extractFromDocument(
  doc: Document,
  url: string,
  opts: { now?: string } = {}
): ArticleCapture {
  const result = new Defuddle(doc, { markdown: true, url }).parse() as DefuddleLikeResult
  return mapToArticleCapture(result, url, opts)
}
