import { describe, expect, it, vi } from 'vitest'

import { createShipQueue } from './ship-queue'

const okFetch = vi.fn(async () => ({ ok: true, status: 202 }))
const make = (fetch = okFetch) =>
  createShipQueue<number>({ fetch, endpoint: 'https://x/logs', buildBody: (items) => ({ items }) })

describe('createShipQueue', () => {
  it('does nothing when disabled', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 202 }))
    const q = make(f)
    q.setEnabled(false)
    q.enqueue(1)
    expect(await q.flush()).toMatchObject({ attempted: 0 })
    expect(f).not.toHaveBeenCalled()
  })
  it('flushes a batch and clears on 2xx', async () => {
    const q = make()
    q.setEnabled(true)
    q.enqueue(1)
    q.enqueue(2)
    expect(await q.flush()).toMatchObject({ success: true, accepted: 2 })
    expect(q.depth()).toBe(0)
  })
  it('drops the batch on a 400 (poison line)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 400 }))
    const q = make(f)
    q.setEnabled(true)
    q.enqueue(1)
    await q.flush()
    expect(q.depth()).toBe(0)
  })
  it('keeps the batch on a 500 (transient)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500 }))
    const q = make(f)
    q.setEnabled(true)
    q.enqueue(1)
    await q.flush()
    expect(q.depth()).toBe(1)
  })
  it('keeps the batch on a 429 (rate limited)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 429 }))
    const q = make(f)
    q.setEnabled(true)
    q.enqueue(1)
    await q.flush()
    expect(q.depth()).toBe(1)
  })
  it('trims to the queue limit', () => {
    const q = createShipQueue<number>({
      fetch: okFetch,
      endpoint: 'x',
      buildBody: (i) => i,
      queueLimit: 3
    })
    q.setEnabled(true)
    for (let i = 0; i < 10; i++) q.enqueue(i)
    expect(q.depth()).toBe(3)
  })
})
