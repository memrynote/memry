import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { TelemetryFetch } from './client'
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

describe('createShipQueue — crash durability', () => {
  let tempDir: string
  let persistPath: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-ship-queue-'))
    persistPath = path.join(tempDir, 'queue.json')
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // A "process death" is modelled by simply dropping the queue object: nothing
  // is flushed, no dispose runs, and the only state that can survive is the
  // on-disk mirror — exactly what a SIGKILL leaves behind.
  const makeDurable = (fetch: TelemetryFetch = okFetch, queueLimit?: number) =>
    createShipQueue<number>({
      fetch,
      endpoint: 'https://x/logs',
      buildBody: (items) => ({ items }),
      persistPath,
      ...(queueLimit === undefined ? {} : { queueLimit })
    })

  it('restores what a killed process enqueued but never flushed', async () => {
    // #given a session that queued two lines and died before its 30s flush
    const dead = makeDurable()
    dead.setEnabled(true)
    dead.enqueue(1)
    dead.enqueue(2)

    // #when the next launch opens the same mirror
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return { ok: true, status: 202 }
    })
    const revived = makeDurable(fetchMock)
    expect(revived.depth()).toBe(2)

    // #then the lines ship on this launch instead of being lost
    revived.setEnabled(true)
    expect(await revived.flush()).toMatchObject({ success: true, accepted: 2 })
    expect(bodies).toEqual([{ items: [1, 2] }])
  })

  it('enforces the queue limit against the persisted set, not just the live one', () => {
    // #given a mirror holding more than this build's limit
    fs.writeFileSync(persistPath, JSON.stringify({ version: 1, items: [1, 2, 3, 4, 5, 6, 7] }))

    // #when the queue restores it
    const q = makeDurable(okFetch, 3)

    // #then the oldest are dropped, and the trim is written back so they do not
    // return on the launch after this one
    expect(q.depth()).toBe(3)
    expect(JSON.parse(fs.readFileSync(persistPath, 'utf-8'))).toEqual({
      version: 1,
      items: [5, 6, 7]
    })
  })

  it('starts clean when the mirror is corrupt instead of blocking startup', () => {
    // #given a mirror truncated by the very crash it was meant to survive
    fs.writeFileSync(persistPath, '{"version":1,"items":[1,2')

    // #when the next launch opens it
    // #then construction succeeds, the queue is empty, and the junk is gone
    const q = makeDurable()
    expect(q.depth()).toBe(0)
    expect(fs.existsSync(persistPath)).toBe(false)
  })

  it('starts clean when the mirror was written by an unknown format version', () => {
    // #given a mirror from a future build
    fs.writeFileSync(persistPath, JSON.stringify({ version: 99, items: [1, 2] }))

    // #when this build opens it
    // #then it is discarded rather than mis-parsed
    expect(makeDurable().depth()).toBe(0)
  })

  it('drains once — a restored batch is not re-sent on the launch after it', async () => {
    // #given a crashed session's lines, drained by the next launch
    const dead = makeDurable()
    dead.setEnabled(true)
    dead.enqueue(1)
    dead.enqueue(2)

    const revived = makeDurable()
    revived.setEnabled(true)
    await revived.flush()

    // #when a third launch opens the same mirror
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }))
    const third = makeDurable(fetchMock)
    third.setEnabled(true)

    // #then there is nothing left to send
    expect(third.depth()).toBe(0)
    expect(await third.flush()).toMatchObject({ attempted: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('restoring twice without a flush does not duplicate the queue', () => {
    // #given a mirror left by a crash
    const dead = makeDurable()
    dead.setEnabled(true)
    dead.enqueue(1)
    dead.enqueue(2)

    // #when two queues restore it (a second instance racing the primary)
    // #then each sees the same two items, never four
    expect(makeDurable().depth()).toBe(2)
    expect(makeDurable().depth()).toBe(2)
  })

  it('turning telemetry off deletes the mirror, not just the in-memory queue', () => {
    // #given queued lines mirrored to disk
    const q = makeDurable()
    q.setEnabled(true)
    q.enqueue(1)
    expect(fs.existsSync(persistPath)).toBe(true)

    // #when the user opts out
    q.setEnabled(false)

    // #then nothing survives the opt-out on disk either
    expect(fs.existsSync(persistPath)).toBe(false)
    expect(makeDurable().depth()).toBe(0)
  })

  it('keeps working when the mirror cannot be written', () => {
    // #given a persist path inside a directory that does not exist
    const q = createShipQueue<number>({
      fetch: okFetch,
      endpoint: 'https://x/logs',
      buildBody: (items) => ({ items }),
      persistPath: path.join(tempDir, 'missing', 'nested', 'queue.json')
    })

    // #when enqueuing
    // #then the in-memory queue still works; durability is the only loss
    q.setEnabled(true)
    expect(() => q.enqueue(1)).not.toThrow()
    expect(q.depth()).toBe(1)
  })
})
