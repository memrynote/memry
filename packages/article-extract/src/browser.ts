import Defuddle from 'defuddle'
import { mapToArticleCapture, type ArticleCapture, type DefuddleLikeResult } from './map.ts'

// Browser counterpart to extractFromHtml: defuddle parses the LIVE DOM (higher
// fidelity than fetched HTML because computed styles are available), then we
// reuse the exact same mapping the Node path uses.
export function extractFromDocument(
  doc: Document,
  url: string,
  opts: { now?: string } = {}
): ArticleCapture {
  const result = new Defuddle(doc, { markdown: true }).parse() as DefuddleLikeResult
  return mapToArticleCapture(result, url, opts)
}
