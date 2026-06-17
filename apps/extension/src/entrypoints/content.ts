import type { ContentMessage, ExtractResponse, PageMetrics } from '@/lib/messages'
import { extractFromDocument } from '@memry/article-extract/browser'
import { toSelectionCapture } from '@/lib/capture-modes'

function grabSelection(): ExtractResponse {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return { ok: false, error: 'no-selection' }
  }
  // ponytail: first range only — multi-range (Ctrl-click) selections are rare;
  // upgrade path = concat cloneContents() of every range.
  const fragment = sel.getRangeAt(0).cloneContents()
  const doc = document.implementation.createHTMLDocument(document.title)
  doc.body.appendChild(fragment)
  const base = extractFromDocument(doc, location.href)
  return { ok: true, capture: toSelectionCapture(base, sel.toString(), document.title) }
}

function pageMetrics(): PageMetrics {
  return {
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    scrollY: window.scrollY
  }
}

export default defineContentScript({
  // ponytail: declared on all web pages (standard clipper pattern); inert until messaged.
  matches: ['*://*/*'],
  main() {
    browser.runtime.onMessage.addListener((message: ContentMessage) => {
      switch (message.type) {
        case 'EXTRACT':
          try {
            return Promise.resolve<ExtractResponse>({
              ok: true,
              capture: extractFromDocument(document, location.href)
            })
          } catch (err) {
            return Promise.resolve<ExtractResponse>({ ok: false, error: String(err) })
          }
        case 'GRAB_SELECTION':
          try {
            return Promise.resolve(grabSelection())
          } catch (err) {
            return Promise.resolve<ExtractResponse>({ ok: false, error: String(err) })
          }
        case 'GET_PAGE_METRICS':
          return Promise.resolve(pageMetrics())
        case 'SCROLL_TO':
          window.scrollTo(0, message.y)
          return Promise.resolve({ ok: true })
        default:
          return Promise.resolve<ExtractResponse>({ ok: false, error: 'unknown-message' })
      }
    })
  }
})
