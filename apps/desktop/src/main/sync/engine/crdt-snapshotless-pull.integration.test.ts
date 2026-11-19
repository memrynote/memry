/**
 * The CRDT body pull against a REAL sync-server (#5234).
 *
 * A fresh Electron bootstrap sent one snapshot GET per note, and 62 of every
 * 100 answered `{ snapshot: null }`: those notes had updates and no snapshot.
 * `POST /sync/crdt/updates/batch` already says which notes have one
 * (`snapshotMeta`). This spec drives `pullCrdtForNotes`, the seam the record
 * pull and the sweep call, over the real HTTP client, the real crypto and real
 * Yjs documents, and reads what it asked the server for.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import sodium from 'libsodium-wrappers-sumo'
import * as Y from 'yjs'

type Recorded = { method: string; path: string; body: unknown }
const requests = vi.hoisted(() => [] as Recorded[])
/** Runs after a matching response arrives, before the client sees it. */
const afterResponse = vi.hoisted(() => ({
  hook: null as ((request: Recorded) => Promise<void>) | null
}))

vi.mock('electron', () => ({
  net: {
    fetch: async (input: RequestInfo, init?: RequestInit) => {
      const request: Recorded = {
        method: init?.method ?? 'GET',
        path: new URL(typeof input === 'string' ? input : input.url).pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      }
      requests.push(request)
      const response = await fetch(input, init)
      const hook = afterResponse.hook
      if (hook) await hook(request)
      return response
    }
  },
  app: { getPath: () => os.tmpdir(), getVersion: () => '99.0.0', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { encryptCrdtUpdate } from '../crdt-encrypt'
import { postToServer, pushCrdtSnapshot, RateLimitError } from '../http-client'
import type { CrdtProvider } from '../crdt-provider'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { SyncContext } from './sync-context'

type Harness = {
  start(): Promise<void>
  stop(): Promise<void>
  getD1(): Promise<D1Database>
  getDirectUrl(): Promise<URL>
  createAccessToken(userId: string, deviceId: string): Promise<string>
}

let server: Harness
const savedUrl = process.env.SYNC_SERVER_URL

beforeAll(async () => {
  // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
  await sodium.ready
  const mod = await import('@memry/sync-harness/simulated-server')
  server = new mod.SimulatedServer()
  await server.start()
  process.env.SYNC_SERVER_URL = (await server.getDirectUrl()).origin
}, 180_000)

afterAll(async () => {
  process.env.SYNC_SERVER_URL = savedUrl
  await server?.stop()
})

async function seedAccount(publicKey: Uint8Array): Promise<{ token: string }> {
  const db = await server.getD1()
  const userId = randomUUID()
  const deviceId = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 5368709120, ?, ?)`
    )
    .bind(userId, `${userId}@example.test`, now, now)
    .run()
  await db
    .prepare(
      `INSERT INTO sync_entitlements (
         user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at
       ) VALUES (?, 'believer', 'active', 'test_seed', 53687091200, 209715200, NULL, 365, ?)`
    )
    .bind(userId, now)
    .run()
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, vault_id, created_at, updated_at)
       VALUES (?, ?, 'test-device', 'test', '99.0.0', ?, 'default', ?, ?)`
    )
    // oxlint-disable-next-line import/no-named-as-default-member -- default import required: tests vi.mock libsodium-wrappers-sumo with only a default export
    .bind(deviceId, userId, sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL), now, now)
    .run()
  await db
    .prepare('INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0)')
    .bind(userId)
    .run()
  return { token: await server.createAccessToken(userId, deviceId) }
}

/** Real Y.Docs in memory: what the coordinator opens, applies into and reads back. */
function memoryProvider(): CrdtProvider & { text(noteId: string): string } {
  const docs = new Map<string, Y.Doc>()
  const provider = {
    storeId: null,
    inactiveDocCapacity: 32,
    isNoteLocalOnly: () => false,
    hasPersistence: () => false,
    getDoc: (noteId: string) => docs.get(noteId),
    open: async (noteId: string) => {
      if (!docs.has(noteId)) docs.set(noteId, new Y.Doc())
      return docs.get(noteId)
    },
    closeIfInactive: async () => false,
    applyRemoteUpdate: (noteId: string, update: Uint8Array) => {
      const doc = docs.get(noteId)
      if (!doc) return false
      Y.applyUpdate(doc, update)
      return true
    },
    getStateVector: (noteId: string) => {
      const doc = docs.get(noteId)
      return doc ? Y.encodeStateVector(doc) : null
    },
    seedFromMarkdownPublic: async () => {},
    recordWholeBodyMerged: () => {},
    text: (noteId: string) => docs.get(noteId)?.getText('body').toJSON() ?? ''
  }
  return provider as unknown as CrdtProvider & { text(noteId: string): string }
}

describe('CRDT body pull against a real sync server', () => {
  const signing = { publicKey: new Uint8Array(), privateKey: new Uint8Array() }
  const vaultKey = new Uint8Array(32)
  let token: string

  beforeAll(async () => {
    const pair = sodium.crypto_sign_keypair()
    signing.publicKey = pair.publicKey
    signing.privateKey = pair.privateKey
    vaultKey.set(sodium.randombytes_buf(32))
    ;({ token } = await seedAccount(signing.publicKey))
  })

  /** The client paces CRDT pushes itself; seeding waits its turn. */
  const paced = async <T>(send: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await send()
      } catch (error) {
        if (!(error instanceof RateLimitError)) throw error
        await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs))
      }
    }
  }

  /** One author's doc per note; each push sends the edit as an encrypted update. */
  const authors = new Map<string, Y.Doc>()
  const edit = (noteId: string, text: string): Uint8Array => {
    const doc = authors.get(noteId) ?? new Y.Doc()
    authors.set(noteId, doc)
    const before = Y.encodeStateVector(doc)
    doc.getText('body').insert(doc.getText('body').length, text)
    return Y.encodeStateAsUpdate(doc, before)
  }
  const pushUpdate = (noteId: string, text: string): Promise<unknown> => {
    const update = Buffer.from(
      encryptCrdtUpdate(edit(noteId, text), vaultKey, noteId, signing.privateKey)
    ).toString('base64')
    return paced(() => postToServer('/sync/crdt/updates', { noteId, updates: [update] }, token))
  }
  const pushSnapshot = (noteId: string, text: string): Promise<unknown> => {
    edit(noteId, text)
    const state = Y.encodeStateAsUpdate(authors.get(noteId)!)
    const encrypted = encryptCrdtUpdate(state, vaultKey, noteId, signing.privateKey)
    return paced(() => pushCrdtSnapshot(noteId, encrypted, token))
  }

  const coordinatorOver = (provider: CrdtProvider): CrdtSyncCoordinator => {
    const ctx = {
      deps: {
        crdtProvider: provider,
        getAccessToken: async () => token,
        getVaultKey: async () => vaultKey.slice()
      },
      abortController: new AbortController()
    } as unknown as SyncContext
    return new CrdtSyncCoordinator(ctx, async () => signing.publicKey)
  }

  const snapshotGets = (): string[] =>
    requests
      .filter((r) => r.method === 'GET' && r.path.startsWith('/sync/crdt/snapshot/'))
      .map((r) => decodeURIComponent(r.path.slice('/sync/crdt/snapshot/'.length)))

  it('sends a snapshot GET only for the notes the server holds a snapshot of', async () => {
    const run = randomUUID().slice(0, 8)
    const bare = [1, 2, 3].map((i) => `bare-${run}-${i}`)
    const snapped = `snapped-${run}`
    for (const noteId of bare) {
      await pushUpdate(noteId, `${noteId} first. `)
      await pushUpdate(noteId, `${noteId} second.`)
    }
    await pushSnapshot(snapped, `${snapped} baseline. `)
    await pushUpdate(snapped, `${snapped} after.`)

    const provider = memoryProvider()
    requests.length = 0
    await coordinatorOver(provider).pullCrdtForNotes([...bare, snapped])

    expect(snapshotGets()).toEqual([snapped])
    for (const noteId of bare) {
      expect(provider.text(noteId)).toBe(`${noteId} first. ${noteId} second.`)
    }
    expect(provider.text(snapped)).toBe(`${snapped} baseline. ${snapped} after.`)
  }, 60_000)

  it('owes a note whose snapshot lands between the probe and the walk, and the next pass fetches it', async () => {
    const run = randomUUID().slice(0, 8)
    const noteId = `racing-${run}`
    await pushUpdate(noteId, 'early. ')

    // Another device snapshots the note right after this device's probe saw
    // none. The snapshot prunes the update the walk would have started from.
    afterResponse.hook = async (request) => {
      const body = request.body as { limit?: number } | undefined
      if (request.path !== '/sync/crdt/updates/batch' || body?.limit !== 1) return
      afterResponse.hook = null
      await pushSnapshot(noteId, 'late.')
    }

    const provider = memoryProvider()
    const coordinator = coordinatorOver(provider)
    requests.length = 0
    try {
      await coordinator.pullCrdtForNotes([noteId])
    } finally {
      afterResponse.hook = null
    }

    // The walk missed the pruned update, so the note may not vouch for itself.
    expect(provider.text(noteId)).not.toBe('early. late.')
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
    expect(coordinator.drainPendingPulls()).toEqual([noteId])

    await coordinator.pullCrdtForNotes([noteId])

    expect(snapshotGets()).toEqual([noteId])
    expect(provider.text(noteId)).toBe('early. late.')
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(false)
  }, 60_000)
})
