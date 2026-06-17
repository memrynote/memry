import { parseHTML } from 'linkedom'
import { Defuddle } from 'defuddle/node'
import { mapToArticleCapture, type ArticleCapture, type DefuddleLikeResult } from './map.ts'

export async function extractFromHtml(
  html: string,
  url: string,
  opts: { now?: string } = {}
): Promise<ArticleCapture> {
  const { document } = parseHTML(html)
  const result = (await Defuddle(document, url, { markdown: true })) as DefuddleLikeResult
  return mapToArticleCapture(result, url, opts)
}
