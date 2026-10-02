import './ios-text-encoding.ts'
import './ios-globals.ts'
import { parseHTML } from 'linkedom'
import { Defuddle } from 'defuddle/node'
import { mapToArticleCapture, type DefuddleLikeResult } from './map.ts'

// The iOS app's article extraction, run in JavaScriptCore: desktop's Node path
// (`node.ts`: linkedom + Defuddle + the shared mapping) with third-party
// fetches off, since the context has no network. Bundled into
// apps/ios/Memry/Resources/article-extract.js by
// scripts/generate-ios-article-extract.mjs.
//
// The app calls `memryExtractArticle(html, url, now)` and reads the
// ArticleCapture JSON from the promise.
async function memryExtractArticle(html: string, url: string, now: string): Promise<string> {
  const { document } = parseHTML(html)
  const result = (await Defuddle(document, url, {
    markdown: true,
    useAsync: false
  })) as DefuddleLikeResult
  return JSON.stringify(mapToArticleCapture(result, url, { now }))
}

;(globalThis as Record<string, unknown>).memryExtractArticle = memryExtractArticle
