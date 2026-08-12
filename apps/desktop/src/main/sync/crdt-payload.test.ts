import { describe, it, expect } from 'vitest'
import {
  planCrdtUpdatePush,
  MAX_CRDT_UPDATE_PAYLOAD_CHARS,
  MAX_CRDT_REQUEST_PAYLOAD_CHARS
} from './crdt-payload'

const payload = (chars: number): string => 'a'.repeat(chars)

describe('planCrdtUpdatePush', () => {
  it('keeps a batch that fits in one request', () => {
    const updates = [payload(10), payload(20)]
    expect(planCrdtUpdatePush(updates)).toEqual({ requests: [updates], oversized: [] })
  })

  it('splits a batch across requests instead of discarding it', () => {
    // Six max-size updates: five fill a request exactly, the sixth starts another.
    const updates = Array.from({ length: 6 }, () => payload(MAX_CRDT_UPDATE_PAYLOAD_CHARS))

    const plan = planCrdtUpdatePush(updates)

    expect(plan.oversized).toHaveLength(0)
    expect(plan.requests.map((request) => request.length)).toEqual([5, 1])
    // Nothing lost, nothing duplicated, order preserved.
    expect(plan.requests.flat()).toHaveLength(updates.length)
    for (const request of plan.requests) {
      const chars = request.reduce((sum, update) => sum + update.length, 0)
      expect(chars).toBeLessThanOrEqual(MAX_CRDT_REQUEST_PAYLOAD_CHARS)
    }
  })

  it('reports an update larger than a single request as oversized, never dropped', () => {
    const huge = payload(MAX_CRDT_UPDATE_PAYLOAD_CHARS + 1)
    const small = payload(32)

    const plan = planCrdtUpdatePush([small, huge, small])

    expect(plan.oversized).toHaveLength(1)
    expect(plan.oversized[0]).toBe(huge)
    expect(plan.requests).toEqual([[small, small]])
  })

  it('sends an update sitting exactly on the per-update budget', () => {
    const exact = payload(MAX_CRDT_UPDATE_PAYLOAD_CHARS)

    const plan = planCrdtUpdatePush([exact])

    expect(plan.oversized).toHaveLength(0)
    expect(plan.requests).toHaveLength(1)
    expect(plan.requests[0]?.[0]).toBe(exact)
  })

  it('handles an empty batch', () => {
    expect(planCrdtUpdatePush([])).toEqual({ requests: [], oversized: [] })
  })

  it('stays inside the server limits it is derived from', () => {
    // D1 caps a row at 1,000,000 bytes and base64 decodes to 3/4 of its length.
    expect((MAX_CRDT_UPDATE_PAYLOAD_CHARS * 3) / 4).toBeLessThan(1_000_000)
    // /sync/* bodies are capped at 8 MiB, envelope included.
    expect(MAX_CRDT_REQUEST_PAYLOAD_CHARS).toBeLessThan(8 * 1024 * 1024)
  })
})
