import type { GuestMsg } from '@memry/contracts/webview-bridge'

export const MARKDOWN_EXPORT_TIMEOUT_MS = 5_000

type MarkdownExportReply = Extract<GuestMsg, { type: 'markdown-export' }>

interface PendingExport {
  docId: string
  resolve: (markdown: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let nextRequestId = 0

/** Promise settlement for the typed RN↔WebView markdown request/reply pair. */
export class MarkdownExportRequests {
  private readonly pending = new Map<string, PendingExport>()

  request(docId: string, send: (reqId: string) => void): Promise<string> {
    const reqId = `markdown:${++nextRequestId}`
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error('Timed out exporting the current note'))
      }, MARKDOWN_EXPORT_TIMEOUT_MS)
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

  settle(reply: MarkdownExportReply): boolean {
    const pending = this.pending.get(reply.reqId)
    if (!pending || pending.docId !== reply.docId) return false
    clearTimeout(pending.timer)
    this.pending.delete(reply.reqId)
    if (reply.result.status === 'ok') pending.resolve(reply.result.markdown)
    else pending.reject(new Error(reply.result.detail))
    return true
  }

  cancelAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The note closed before its markdown was exported'))
    }
    this.pending.clear()
  }

  pendingCount(): number {
    return this.pending.size
  }
}
