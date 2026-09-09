/** Markdown is the document re-serialized; the guest answers quickly. */
export const MARKDOWN_EXPORT_TIMEOUT_MS = 5_000

/**
 * Longer, because the HTML reply is the rendered subtree and every stylesheet
 * it is running under, which on a note with inlined images is megabytes of
 * string crossing the bridge.
 */
export const HTML_EXPORT_TIMEOUT_MS = 15_000

/** What the guest sends back when it could not produce the export. */
interface ExportFailure {
  status: 'error'
  detail: string
}

interface PendingExport {
  docId: string
  resolve: (value: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let nextRequestId = 0

/**
 * Promise settlement for a typed RN↔WebView export request/reply pair.
 *
 * Markdown and HTML differ only in the key their success result carries, so
 * `readOk` is the whole of the difference and the pending map, the timeout and
 * the docId check are written once. Each instance keeps its OWN map, which is
 * what stops one export settling the other's promise.
 */
export class ExportRequests<TOk extends { status: 'ok' }> {
  private readonly pending = new Map<string, PendingExport>()

  constructor(
    private readonly kind: string,
    private readonly timeoutMs: number,
    private readonly readOk: (result: TOk) => string
  ) {}

  request(docId: string, send: (reqId: string) => void): Promise<string> {
    const reqId = `${this.kind}:${++nextRequestId}`
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error('Timed out exporting the current note'))
      }, this.timeoutMs)
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

  settle(reply: { reqId: string; docId: string; result: TOk | ExportFailure }): boolean {
    const pending = this.pending.get(reply.reqId)
    if (!pending || pending.docId !== reply.docId) return false
    clearTimeout(pending.timer)
    this.pending.delete(reply.reqId)
    if (reply.result.status === 'error') pending.reject(new Error(reply.result.detail))
    else pending.resolve(this.readOk(reply.result))
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

export function createMarkdownExportRequests(): ExportRequests<{
  status: 'ok'
  markdown: string
}> {
  return new ExportRequests('markdown', MARKDOWN_EXPORT_TIMEOUT_MS, (result) => result.markdown)
}

export function createHtmlExportRequests(): ExportRequests<{ status: 'ok'; html: string }> {
  return new ExportRequests('html', HTML_EXPORT_TIMEOUT_MS, (result) => result.html)
}
