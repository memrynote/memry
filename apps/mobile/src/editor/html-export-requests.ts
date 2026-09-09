import type { GuestMsg } from '@memry/contracts/webview-bridge'

/**
 * Longer than the markdown request's budget. The guest serializes its whole
 * rendered subtree and every stylesheet it is running under, which on a long
 * note with inlined images is megabytes of string crossing the bridge, where
 * markdown is the document re-serialized and comparatively tiny.
 */
export const HTML_EXPORT_TIMEOUT_MS = 15_000

type HtmlExportReply = Extract<GuestMsg, { type: 'html-export' }>

interface PendingExport {
  docId: string
  resolve: (html: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let nextRequestId = 0

/** Promise settlement for the typed RN↔WebView HTML request/reply pair. */
export class HtmlExportRequests {
  private readonly pending = new Map<string, PendingExport>()

  request(docId: string, send: (reqId: string) => void): Promise<string> {
    const reqId = `html:${++nextRequestId}`
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error('Timed out exporting the current note'))
      }, HTML_EXPORT_TIMEOUT_MS)
      this.pending.set(reqId, { docId, resolve, reject, timer })
      try {
        send(reqId)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(reqId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  settle(reply: HtmlExportReply): boolean {
    const pending = this.pending.get(reply.reqId)
    if (!pending || pending.docId !== reply.docId) return false
    clearTimeout(pending.timer)
    this.pending.delete(reply.reqId)
    if (reply.result.status === 'ok') pending.resolve(reply.result.html)
    else pending.reject(new Error(reply.result.detail))
    return true
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The note closed before it was exported'))
    }
    this.pending.clear()
  }

  pendingCount(): number {
    return this.pending.size
  }
}
