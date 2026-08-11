import { describe, it, expect } from 'vitest'
import type { ArticleCapture } from '@memry/article-extract'
import {
  badgeText,
  dequeueById,
  enqueue,
  isQueueable,
  isRetryable,
  MAX_QUEUE
} from './capture-queue'

const cap = { url: 'https://x.test' } as unknown as ArticleCapture
const item = (id: string) => ({ id, capture: cap, queuedAt: 0 })

describe('isRetryable', () => {
  it('retries only unreachable-server errors', () => {
    expect(isRetryable('app-closed')).toBe(true)
    expect(isRetryable('network')).toBe(true)
  })
  it('does not retry payload/auth/4xx/5xx failures', () => {
    expect(isRetryable('bad-token')).toBe(false)
    expect(isRetryable('origin-not-allowed')).toBe(false)
    expect(isRetryable('invalid-capture')).toBe(false)
    expect(isRetryable('payload-too-large')).toBe(false)
    expect(isRetryable('http-413')).toBe(false)
    expect(isRetryable('http-500')).toBe(false)
  })
})

describe('enqueue', () => {
  it('appends to the end', () => {
    expect(enqueue([item('a')], item('b')).map((q) => q.id)).toEqual(['a', 'b'])
  })
  it('drops the oldest when over the cap', () => {
    const r = enqueue([item('a'), item('b')], item('c'), 2)
    expect(r.map((q) => q.id)).toEqual(['b', 'c'])
  })
  it('defaults to MAX_QUEUE', () => {
    expect(MAX_QUEUE).toBe(50)
  })
})

describe('dequeueById', () => {
  it('removes the matching item', () => {
    expect(dequeueById([item('a'), item('b')], 'a').map((q) => q.id)).toEqual(['b'])
  })
})

describe('badgeText', () => {
  it('blanks at zero, caps at 99+', () => {
    expect(badgeText(0)).toBe('')
    expect(badgeText(5)).toBe('5')
    expect(badgeText(150)).toBe('99+')
  })
})

describe('isQueueable', () => {
  it('queues an ordinary article capture', () => {
    expect(isQueueable({ url: 'https://x.test', mode: 'article' } as ArticleCapture)).toBe(true)
  })

  it('never queues a capture carrying pdf bytes', () => {
    // storage.local is capped at 10MB without unlimitedStorage; a 16MB PDF
    // base64s to ~21MB and would blow the quota.
    expect(
      isQueueable({
        url: 'https://x.test/a.pdf',
        mode: 'pdf',
        pdfDataUrl: 'data:application/pdf;base64,JVBERi0='
      } as ArticleCapture)
    ).toBe(false)
  })
})
