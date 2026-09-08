import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MARKDOWN_EXPORT_TIMEOUT_MS, MarkdownExportRequests } from '../markdown-export-requests'

describe('MarkdownExportRequests', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('settles the matching request with live markdown', async () => {
    const requests = new MarkdownExportRequests()
    let reqId = ''
    const result = requests.request('note-1', (next) => {
      reqId = next
    })

    expect(
      requests.settle({
        type: 'markdown-export',
        reqId,
        docId: 'note-1',
        result: { status: 'ok', markdown: 'Live body' }
      })
    ).toBe(true)
    await expect(result).resolves.toBe('Live body')
    expect(requests.pendingCount()).toBe(0)
  })

  it('ignores a reply addressed to another document', async () => {
    const requests = new MarkdownExportRequests()
    let reqId = ''
    const result = requests.request('note-1', (next) => {
      reqId = next
    })
    const cancellation = expect(result).rejects.toThrow('note closed')

    expect(
      requests.settle({
        type: 'markdown-export',
        reqId,
        docId: 'note-2',
        result: { status: 'ok', markdown: 'Wrong note' }
      })
    ).toBe(false)
    expect(requests.pendingCount()).toBe(1)
    requests.cancelAll()
    await cancellation
  })

  it('rejects on guest failure, timeout, and route cleanup', async () => {
    const failed = new MarkdownExportRequests()
    let failedId = ''
    const failure = failed.request('note-1', (next) => {
      failedId = next
    })
    failed.settle({
      type: 'markdown-export',
      reqId: failedId,
      docId: 'note-1',
      result: { status: 'error', detail: 'Serializer failed' }
    })
    await expect(failure).rejects.toThrow('Serializer failed')

    const timedOut = new MarkdownExportRequests()
    const timeout = timedOut.request('note-1', () => undefined)
    const timeoutAssertion = expect(timeout).rejects.toThrow('Timed out exporting')
    vi.advanceTimersByTime(MARKDOWN_EXPORT_TIMEOUT_MS)
    await timeoutAssertion

    const cancelled = new MarkdownExportRequests()
    const cancellation = cancelled.request('note-1', () => undefined)
    const cancellationAssertion = expect(cancellation).rejects.toThrow('note closed')
    cancelled.cancelAll()
    await cancellationAssertion
  })
})
