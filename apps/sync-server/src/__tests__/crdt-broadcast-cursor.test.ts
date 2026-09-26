import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { errorHandler } from '../lib/errors'
import { storeSnapshot } from '../services/crdt'
import type { AppContext, Bindings } from '../types'

/**
 * #2420: the `crdt_updated` broadcast carries the highest server_cursor the
 * write reserved, and only when the write stored something new. Runs the real
 * routes against the real schema; the Durable Object stub records each frame
 * the route asks it to broadcast.
 */

const USER_ID = 'user-crdt-cursor'
const VAULT_ID = 'default'
const DEVICE_ID = 'device-pusher'
const PEER_ID = 'device-peer'

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', USER_ID)
    c.set('deviceId', DEVICE_ID)
    await next()
  }
}))

const { sync } = await import('../routes/sync')

let harness: SqliteD1
let storage: R2Bucket
let env: Bindings
let frames: Array<Record<string, unknown>>
let scheduled: Array<Promise<unknown>>

const now = (): number => Math.floor(Date.now() / 1000)
const b64 = (value: string): string => Buffer.from(value).toString('base64')
const bytes = (value: string): ArrayBuffer => {
  const encoded = new TextEncoder().encode(value)
  const copy = new Uint8Array(encoded.byteLength)
  copy.set(encoded)
  return copy.buffer
}

/** Makes the next reserved cursor `value + 1`. */
const setCursorSequence = (value: number): void => {
  harness.raw
    .prepare(
      `INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET current_cursor = excluded.current_cursor`
    )
    .run(USER_ID, value)
}

const snapshotCursor = (noteId: string): number | null =>
  (
    harness.raw
      .prepare(
        'SELECT server_cursor FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND note_id = ?'
      )
      .get(USER_ID, VAULT_ID, noteId) as { server_cursor: number | null }
  ).server_cursor

const post = async (path: string, body: unknown): Promise<Response> => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync', sync)
  const res = await app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    env as unknown as Record<string, unknown>,
    {
      waitUntil: (promise: Promise<unknown>) => {
        scheduled.push(promise)
      },
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )
  await Promise.all(scheduled)
  return res
}

const crdtFrames = (): Array<Record<string, unknown>> =>
  frames.filter((frame) => frame.type === 'crdt_updated')

beforeEach(() => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  frames = []
  scheduled = []
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, 'crdt-cursor@example.com', now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Desktop', 'desktop', '1.0.0', 'key', ?, ?)`
    )
    .run(DEVICE_ID, USER_ID, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run('vault-row', USER_ID, VAULT_ID, now(), now())
  // Open the #2299 claim gate so claimed pushes are refused as in production
  // after the rollout.
  harness.raw
    .prepare(
      `INSERT INTO client_policies (platform, min_write_version, writes_enabled, updated_at)
       VALUES ('desktop', '1.0.0', 1, ?)`
    )
    .run(now())
  env = {
    DB: harness.db,
    STORAGE: storage,
    ENVIRONMENT: 'development',
    CRDT_CLAIM_MIN_DESKTOP_VERSION: '1.0.0',
    USER_SYNC_STATE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          frames.push((await request.json()) as Record<string, unknown>)
          return Response.json({ sent: 1 })
        }
      })
    },
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ count: 1, windowStart: now() })
      })
    }
  } as unknown as Bindings
})

afterEach(() => {
  harness.close()
})

describe('crdt_updated carries the reserved cursor (#2420)', () => {
  // #2420
  it('carries the highest cursor an update push reserved', async () => {
    setCursorSequence(40)

    const res = await post('/sync/crdt/updates', {
      noteId: 'note-1',
      updates: [b64('a'), b64('b'), b64('c')]
    })

    expect(res.status).toBe(200)
    expect(crdtFrames()).toEqual([
      {
        excludeDeviceId: DEVICE_ID,
        vaultId: VAULT_ID,
        type: 'crdt_updated',
        noteId: 'note-1',
        cursor: 43
      }
    ])
  })

  // #2420: a partly retried push names only the rows it inserted.
  it('carries the cursor of the newly inserted row when the last update is a retry', async () => {
    await post('/sync/crdt/updates', { noteId: 'note-1', updates: [b64('a')] })
    frames = []

    await post('/sync/crdt/updates', { noteId: 'note-1', updates: [b64('b'), b64('a')] })

    // Cursor 1 went to `a`; this batch reserved 2..3, and `b` took 2.
    expect(crdtFrames()).toEqual([
      expect.objectContaining({ type: 'crdt_updated', noteId: 'note-1', cursor: 2 })
    ])
  })

  // #2420 / #2296: a duplicate-only retry stores nothing new, so it has no cursor.
  it('omits the cursor on a duplicate-only retry and still broadcasts', async () => {
    await post('/sync/crdt/updates', { noteId: 'note-1', updates: [b64('a'), b64('b')] })
    frames = []

    const res = await post('/sync/crdt/updates', {
      noteId: 'note-1',
      updates: [b64('a'), b64('b')]
    })

    expect(res.status).toBe(200)
    expect(crdtFrames()).toEqual([
      { excludeDeviceId: DEVICE_ID, vaultId: VAULT_ID, type: 'crdt_updated', noteId: 'note-1' }
    ])
  })

  // #2420
  it('carries the stored row cursor on a single snapshot push', async () => {
    setCursorSequence(70)

    const res = await post('/sync/crdt/snapshot', { noteId: 'note-1', snapshot: b64('state') })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sequenceNum: 0, revision: expect.any(String) })
    expect(snapshotCursor('note-1')).toBe(71)
    expect(crdtFrames()).toEqual([
      {
        excludeDeviceId: DEVICE_ID,
        vaultId: VAULT_ID,
        type: 'crdt_updated',
        noteId: 'note-1',
        cursor: 71
      }
    ])
  })

  // #2420
  it('carries each stored row cursor on the per-note frames of a batch push', async () => {
    setCursorSequence(10)

    const res = await post('/sync/crdt/snapshot/batch', {
      snapshots: [
        { noteId: 'note-a', snapshot: b64('a') },
        { noteId: 'note-b', snapshot: b64('b') }
      ]
    })

    expect(res.status).toBe(200)
    // The response shape is unchanged: no cursor rides on the results.
    expect(await res.json()).toEqual({
      results: [
        { noteId: 'note-a', accepted: true, sequenceNum: 0, revision: expect.any(String) },
        { noteId: 'note-b', accepted: true, sequenceNum: 0, revision: expect.any(String) }
      ]
    })
    expect([snapshotCursor('note-a'), snapshotCursor('note-b')]).toEqual([11, 12])
    expect(crdtFrames()).toEqual([
      expect.objectContaining({ noteId: 'note-a', cursor: 11 }),
      expect.objectContaining({ noteId: 'note-b', cursor: 12 })
    ])
  })

  // #2420: a refused write broadcasts nothing, as before.
  it('broadcasts nothing for a refused snapshot write', async () => {
    setCursorSequence(60)
    await storeSnapshot(
      harness.db,
      storage,
      USER_ID,
      VAULT_ID,
      'note-1',
      PEER_ID,
      bytes('peer'),
      null,
      {
        coversThrough: 60
      }
    )

    const single = await post('/sync/crdt/snapshot', {
      noteId: 'note-1',
      snapshot: b64('state'),
      coversThrough: 50
    })
    const batch = await post('/sync/crdt/snapshot/batch', {
      snapshots: [{ noteId: 'note-1', snapshot: b64('state'), coversThrough: 50 }]
    })

    expect(single.status).toBe(409)
    expect(batch.status).toBe(200)
    expect(crdtFrames()).toEqual([])
  })

  // #2420: an older encode of this device is refused like any stale encode
  // (#2299), so it broadcasts nothing.
  it('broadcasts nothing for an older own encode, single and batch', async () => {
    setCursorSequence(22)
    await post('/sync/crdt/snapshot', {
      noteId: 'note-1',
      snapshot: b64('newer'),
      coversThrough: 22
    })
    frames = []

    const single = await post('/sync/crdt/snapshot', {
      noteId: 'note-1',
      snapshot: b64('older'),
      coversThrough: 10
    })
    const batch = await post('/sync/crdt/snapshot/batch', {
      snapshots: [{ noteId: 'note-1', snapshot: b64('older'), coversThrough: 10 }]
    })

    expect(single.status).toBe(409)
    expect(batch.status).toBe(200)
    expect(crdtFrames()).toEqual([])
  })
})
