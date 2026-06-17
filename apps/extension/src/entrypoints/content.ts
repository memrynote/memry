import type { ContentMessage, ExtractResponse } from '@/lib/messages'
import { extractFromDocument } from '@memry/article-extract/browser'

export default defineContentScript({
  // ponytail: declared on all web pages (standard clipper pattern); inert until messaged.
  matches: ['*://*/*'],
  main() {
    browser.runtime.onMessage.addListener((message: ContentMessage): Promise<ExtractResponse> => {
      if (message.type !== 'EXTRACT')
        return Promise.resolve({ ok: false, error: 'unknown-message' })
      try {
        return Promise.resolve({ ok: true, capture: extractFromDocument(document, location.href) })
      } catch (err) {
        return Promise.resolve({ ok: false, error: String(err) })
      }
    })
  }
})
