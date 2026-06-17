import { parseHTML } from 'linkedom'
import { mapToArticleCapture, type ArticleCapture, type DefuddleLikeResult } from './map.ts'

export async function extractFromHtml(
  html: string,
  url: string,
  opts: { now?: string } = {}
): Promise<ArticleCapture> {
  // defuddle's `./node` export declares only an `import` condition (no `require`).
  // The Electron main process bundles to CommonJS, where a static `import` is
  // emitted as `require('defuddle/node')` and throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // at load. A native dynamic import keeps the `import` condition and resolves —
  // the same pattern main already relies on for `await import('electron')`.
  const { Defuddle } = await import('defuddle/node')
  // linkedom types parseHTML() as `Window & typeof globalThis`, whose `document`
  // only resolves under the DOM lib. Cast to Defuddle's own parameter type so
  // this stays correct without pulling DOM types into a Node-only package.
  const { document } = parseHTML(html) as unknown as {
    document: Parameters<typeof Defuddle>[0]
  }
  const result = (await Defuddle(document, url, { markdown: true })) as DefuddleLikeResult
  return mapToArticleCapture(result, url, opts)
}
