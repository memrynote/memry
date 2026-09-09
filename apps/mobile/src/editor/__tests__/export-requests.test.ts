import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createHtmlExportRequests,
  createMarkdownExportRequests,
  HTML_EXPORT_TIMEOUT_MS,
  MARKDOWN_EXPORT_TIMEOUT_MS
} from '../export-requests'

describe('ExportRequests', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('settles the matching request with live markdown', async () => {
    const requests = createMarkdownExportRequests()
    let reqId = ''
    const result = requests.request('note-1', (next) => {
      reqId = next
    })

    expect(
      requests.settle({
        reqId,
        docId: 'note-1',
        result: { status: 'ok', markdown: 'Live body' }
      })
    ).toBe(true)
    await expect(result).resolves.toBe('Live body')
    expect(requests.pendingCount()).toBe(0)
  })

  it('settles the matching request with live html', async () => {
    const requests = createHtmlExportRequests()
    let reqId = ''
    const result = requests.request('note-1', (next) => {
      reqId = next
    })

    expect(
      requests.settle({
        reqId,
        docId: 'note-1',
        result: { status: 'ok', html: '<p>Live body</p>' }
      })
    ).toBe(true)
    await expect(result).resolves.toBe('<p>Live body</p>')
    expect(requests.pendingCount()).toBe(0)
  })

  it('ignores a reply addressed to another document', async () => {
    const requests = createMarkdownExportRequests()
    let reqId = ''
    const result = requests.request('note-1', (next) => {
      reqId = next
    })
    const cancellation = expect(result).rejects.toThrow('note closed')

    expect(
      requests.settle({
        reqId,
        docId: 'note-2',
        result: { status: 'ok', markdown: 'Wrong note' }
      })
    ).toBe(false)
    expect(requests.pendingCount()).toBe(1)
    requests.cancelAll()
    await cancellation
  })

  /**
   * The two registries share a request-id counter but not a pending map, so a
   * markdown reply must never resolve an HTML export that is still in flight.
   */
  it('does not settle the other export kind', async () => {
    const markdown = createMarkdownExportRequests()
    const html = createHtmlExportRequests()
    let htmlId = ''
    const pending = html.request('note-1', (next) => {
      htmlId = next
    })
    const cancellation = expect(pending).rejects.toThrow('note closed')

    expect(
      markdown.settle({
        reqId: htmlId,
        docId: 'note-1',
        result: { status: 'ok', markdown: 'Nope' }
      })
    ).toBe(false)
    expect(html.pendingCount()).toBe(1)
    html.cancelAll()
    await cancellation
  })

  it('rejects on guest failure, timeout, and route cleanup', async () => {
    const failed = createMarkdownExportRequests()
    let failedId = ''
    const failure = failed.request('note-1', (next) => {
      failedId = next
    })
    failed.settle({
      reqId: failedId,
      docId: 'note-1',
      result: { status: 'error', detail: 'Serializer failed' }
    })
    await expect(failure).rejects.toThrow('Serializer failed')

    const timedOut = createMarkdownExportRequests()
    const timeout = timedOut.request('note-1', () => undefined)
    const timeoutAssertion = expect(timeout).rejects.toThrow('Timed out exporting')
    vi.advanceTimersByTime(MARKDOWN_EXPORT_TIMEOUT_MS)
    await timeoutAssertion

    const cancelled = createMarkdownExportRequests()
    const cancellation = cancelled.request('note-1', () => undefined)
    const cancellationAssertion = expect(cancellation).rejects.toThrow('note closed')
    cancelled.cancelAll()
    await cancellationAssertion
  })

  /** The HTML payload is far larger, so it is deliberately given longer. */
  it('gives html exports the longer budget', async () => {
    const requests = createHtmlExportRequests()
    const pending = requests.request('note-1', () => undefined)
    const assertion = expect(pending).rejects.toThrow('Timed out exporting')

    vi.advanceTimersByTime(MARKDOWN_EXPORT_TIMEOUT_MS)
    expect(requests.pendingCount()).toBe(1)

    vi.advanceTimersByTime(HTML_EXPORT_TIMEOUT_MS - MARKDOWN_EXPORT_TIMEOUT_MS)
    await assertion
    expect(requests.pendingCount()).toBe(0)
  })
})
