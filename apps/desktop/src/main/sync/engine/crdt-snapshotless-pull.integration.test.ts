/**
 * The CRDT body pull against a REAL sync-server (#5234).
 *
 * A fresh Electron bootstrap sent one snapshot GET per note, and 62 of every
 * 100 answered `{ snapshot: null }`: those notes had updates and no snapshot.
 * `POST /sync/crdt/updates/batch` already says which notes have one
 * (`snapshotMeta`). This spec drives `pullCrdtForNotes`, the seam the record
 * pull and the sweep call, over the real HTTP client, the real crypto and real
 * Yjs documents, and reads what it asked the server for. It also pins that a
 * note the server holds a body for is never seeded from markdown (#5286).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import sodium from 'libsodium-wrappers-sumo'
import * as Y from 'yjs'
import type * as LoggerModule from '../../lib/logger'

type Recorded = { method: string; path: string; body: unknown }
const requests = vi.hoisted(() => [] as Recorded[])
/** Runs after a matching response arrives, before the client sees it. */
const afterResponse = vi.hoisted(() => ({
  hook: null as ((request: Recorded) => Promise<void>) | null
}))
const coordinatorLogs = vi.hoisted(
  () => [] as Array<{ level: 'info' | 'debug'; message: string; meta: unknown }>
)

// Records the coordinator's info and debug lines and still writes every line,
// so a failing run keeps its log output.
vi.mock('../../lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof LoggerModule>()
  return {
    ...actual,
    createLogger: (scope: string) => {
      const logger = actual.createLogger(scope)
      if (scope !== 'CrdtSyncCoordinator') return logger
      const recorded =
        (level: 'info' | 'debug') =>
        (message: string, ...rest: unknown[]): void => {
          coordinatorLogs.push({ level, message, meta: rest[0] })
          logger[level](message, ...rest)
        }
      return { ...logger, info: recorded('info'), debug: recorded('debug') }
    }
  }
})

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

type MemoryProvider = CrdtProvider & {
  text(noteId: string): string
  /** Notes whose doc the cache is closing: updates are refused, the doc stays empty. */
  closing: Set<string>
  /** Notes seeded from markdown. */
  seeded: string[]
}

/** Real Y.Docs in memory: what the coordinator opens, applies into and reads back. */
function memoryProvider(): MemoryProvider {
  const docs = new Map<string, Y.Doc>()
  const closing = new Set<string>()
  const seeded: string[] = []
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
      if (!doc || closing.has(noteId)) return false
      Y.applyUpdate(doc, update)
      return true
    },
    getStateVector: (noteId: string) => {
      const doc = docs.get(noteId)
      return doc ? Y.encodeStateVector(doc) : null
    },
    seedFromMarkdownPublic: async (noteId: string) => {
      seeded.push(noteId)
      docs.get(noteId)?.getText('body').insert(0, 'markdown. ')
    },
    recordWholeBodyMerged: () => {},
    text: (noteId: string) => docs.get(noteId)?.getText('body').toJSON() ?? '',
    closing,
    seeded
  }
  return provider as unknown as MemoryProvider
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

  /** Updates from a second, independent author: no struct of them waits on the first. */
  const pushForeignUpdates = async (noteId: string, texts: string[]): Promise<void> => {
    const doc = new Y.Doc()
    const updates = texts.map((text) => {
      const before = Y.encodeStateVector(doc)
      doc.getText('body').insert(doc.getText('body').length, text)
      const update = Y.encodeStateAsUpdate(doc, before)
      return Buffer.from(encryptCrdtUpdate(update, vaultKey, noteId, signing.privateKey)).toString(
        'base64'
      )
    })
    // The server takes at most 100 updates per push.
    for (let i = 0; i < updates.length; i += 100) {
      const chunk = updates.slice(i, i + 100)
      await paced(() => postToServer('/sync/crdt/updates', { noteId, updates: chunk }, token))
    }
  }

  /** `fullSyncActive` probes every chunk; outside one a small cold chunk is not probed. */
  const coordinatorOver = (
    provider: CrdtProvider,
    fullSyncActive = false,
    takesBody?: (noteId: string) => boolean
  ): CrdtSyncCoordinator => {
    const ctx = {
      fullSyncActive,
      deps: {
        crdtProvider: provider,
        getAccessToken: async () => token,
        getVaultKey: async () => vaultKey.slice()
      },
      abortController: new AbortController()
    } as unknown as SyncContext
    return new CrdtSyncCoordinator(ctx, async () => signing.publicKey, takesBody)
  }

  const isSnapshotGet = (r: Recorded): boolean =>
    r.method === 'GET' && r.path.startsWith('/sync/crdt/snapshot/')
  const isProbe = (r: Recorded): boolean =>
    r.path === '/sync/crdt/updates/batch' && (r.body as { limit?: number }).limit === 1
  const snapshotGets = (): string[] =>
    requests
      .filter(isSnapshotGet)
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
    await coordinatorOver(provider, true).pullCrdtForNotes([...bare, snapped])

    expect(snapshotGets()).toEqual([snapped])
    for (const noteId of bare) {
      expect(provider.text(noteId)).toBe(`${noteId} first. ${noteId} second.`)
    }
    expect(provider.text(snapped)).toBe(`${snapped} baseline. ${snapped} after.`)
  }, 60_000)

  it('sends no probe and a snapshot GET for every note of a small cold chunk outside a fullSync', async () => {
    const run = randomUUID().slice(0, 8)
    const bare = `bare-${run}`
    const snapped = `snapped-${run}`
    await pushUpdate(bare, `${bare} first.`)
    await pushSnapshot(snapped, `${snapped} baseline. `)
    await pushUpdate(snapped, `${snapped} after.`)

    const provider = memoryProvider()
    requests.length = 0
    await coordinatorOver(provider).pullCrdtForNotes([bare, snapped])

    const probes = requests.filter(
      (r) => r.path === '/sync/crdt/updates/batch' && (r.body as { limit?: number }).limit === 1
    )
    expect(probes).toEqual([])
    expect(snapshotGets()).toEqual([bare, snapped])
    expect(provider.text(bare)).toBe(`${bare} first.`)
    expect(provider.text(snapped)).toBe(`${snapped} baseline. ${snapped} after.`)
  }, 60_000)

  it('owes a note whose snapshot lands between its null snapshot GET and the walk', async () => {
    const run = randomUUID().slice(0, 8)
    const noteId = `racing-get-${run}`
    await pushUpdate(noteId, 'early. ')

    // No probe on this small cold chunk: the GET answers no snapshot, then
    // another device snapshots the note and prunes the update the walk from 0
    // would have read.
    afterResponse.hook = async (request) => {
      if (request.method !== 'GET' || !request.path.startsWith('/sync/crdt/snapshot/')) return
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

    expect(provider.text(noteId)).not.toBe('early. late.')
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
    expect(coordinator.drainPendingPulls()).toEqual([noteId])

    await coordinator.pullCrdtForNotes([noteId])

    expect(snapshotGets()).toEqual([noteId, noteId])
    expect(provider.text(noteId)).toBe('early. late.')
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(false)
  }, 60_000)

  // #5474: the single-note pull (a `crdt_updated` broadcast, the pending-note
  // replay) has the same window, and the replay pushes a snapshot on `true`.
  it('owes a note whose snapshot lands between its null snapshot GET and the single-note walk', async () => {
    const noteId = `racing-single-${randomUUID().slice(0, 8)}`
    await pushUpdate(noteId, 'early. ')

    afterResponse.hook = async (request) => {
      if (request.method !== 'GET' || !request.path.startsWith('/sync/crdt/snapshot/')) return
      afterResponse.hook = null
      await pushSnapshot(noteId, 'late.')
    }

    const provider = memoryProvider()
    const coordinator = coordinatorOver(provider)
    requests.length = 0
    let merged: boolean
    try {
      merged = await coordinator.pullCrdtForNote(noteId)
    } finally {
      afterResponse.hook = null
    }

    expect(merged).toBe(false)
    expect(provider.seeded).toEqual([])
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
    expect(coordinator.drainPendingPulls()).toEqual([noteId])

    expect(await coordinator.pullCrdtForNote(noteId)).toBe(true)

    expect(snapshotGets()).toEqual([noteId, noteId])
    expect(provider.text(noteId)).toBe('early. late.')
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(false)
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
    const coordinator = coordinatorOver(provider, true)
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

  // #5477: the walk holds snapshot S1 as its baseline, and a peer's S2 prunes
  // the updates between them. `tail.` comes from an independent author, so no
  // pending struct flags the note: only the page's `snapshotMeta` can. The
  // tail is one update more than a page holds, so the page that names S2 says
  // `hasMore` and only the owe ends the walk there (#5247).
  const fragments = ['base. ', 'mid. ', 'late. ', 'tail.']
  const tail = ['tail.', ...Array.from({ length: 100 }, () => '+')]
  const isUpdatePage = (r: Recorded): boolean =>
    (r.path === '/sync/crdt/updates/batch' && (r.body as { limit?: number }).limit === 100) ||
    (r.method === 'GET' && r.path === '/sync/crdt/updates')
  it.each(['single', 'batch'] as const)(
    'owes a %s walk whose held snapshot a newer peer snapshot replaces before the walk',
    async (mode) => {
      const noteId = `rebased-${mode}-${randomUUID().slice(0, 8)}`
      await pushSnapshot(noteId, 'base. ')
      await pushUpdate(noteId, 'mid. ')

      afterResponse.hook = async (request) => {
        if (request.method !== 'GET' || !request.path.startsWith('/sync/crdt/snapshot/')) return
        afterResponse.hook = null
        await pushSnapshot(noteId, 'late. ')
        await pushForeignUpdates(noteId, tail)
      }

      const provider = memoryProvider()
      const coordinator = coordinatorOver(provider)
      const pull = async (): Promise<boolean | undefined> =>
        mode === 'single'
          ? coordinator.pullCrdtForNote(noteId)
          : coordinator.pullCrdtForNotes([noteId]).then(() => undefined)
      requests.length = 0
      let merged: boolean | undefined
      try {
        merged = await pull()
      } finally {
        afterResponse.hook = null
      }

      expect(merged).toBe(mode === 'single' ? false : undefined)
      // The page naming S2 ends the walk: none of its updates reaches the doc,
      // and the walk asks for no further page.
      expect(requests.filter(isUpdatePage)).toHaveLength(1)
      expect(provider.text(noteId)).toBe('base. ')
      expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
      expect(coordinator.drainPendingPulls()).toEqual([noteId])

      const second = await pull()

      expect(second).toBe(mode === 'single' ? true : undefined)
      expect(snapshotGets()).toEqual([noteId, noteId])
      for (const text of fragments) expect(provider.text(noteId)).toContain(text)
      expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(false)
    },
    60_000
  )

  it('owes a note whose probe-matched snapshot a newer peer snapshot replaces before the walk', async () => {
    const noteId = `rebased-probe-${randomUUID().slice(0, 8)}`
    await pushSnapshot(noteId, 'base. ')
    await pushUpdate(noteId, 'mid. ')
    const provider = memoryProvider()
    const coordinator = coordinatorOver(provider, true)
    await coordinator.pullCrdtForNotes([noteId])
    expect(provider.text(noteId)).toBe('base. mid. ')

    // The probe proves S1 is the merged baseline and skips its GET; S2 lands
    // before the walk and prunes `more.`.
    await pushUpdate(noteId, 'more. ')
    afterResponse.hook = async (request) => {
      if (!isProbe(request)) return
      afterResponse.hook = null
      await pushSnapshot(noteId, 'late. ')
      await pushForeignUpdates(noteId, ['tail.'])
    }
    requests.length = 0
    try {
      await coordinator.pullCrdtForNotes([noteId])
    } finally {
      afterResponse.hook = null
    }

    expect(snapshotGets()).toEqual([])
    expect(provider.text(noteId)).not.toContain('late.')
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
    expect(coordinator.drainPendingPulls()).toEqual([noteId])

    await coordinator.pullCrdtForNotes([noteId])

    expect(snapshotGets()).toEqual([noteId])
    for (const text of [...fragments, 'more. ']) expect(provider.text(noteId)).toContain(text)
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(false)
  }, 60_000)

  // #5247: that owe counts no failed pull, so a note a peer keeps snapshotting
  // could stay owed walk after walk with no other trace.
  /**
   * One pass over `noteId`; `churnAfter` names the read a peer's snapshot lands
   * right after. Returns every owed-again line logged for the note so far.
   */
  const churnPass = async (
    coordinator: CrdtSyncCoordinator,
    noteId: string,
    churnAfter?: (request: Recorded) => boolean,
    mode: 'single' | 'batch' = 'batch'
  ): Promise<Array<[string, number]>> => {
    afterResponse.hook = async (request) => {
      if (!churnAfter?.(request)) return
      afterResponse.hook = null
      await pushSnapshot(noteId, 'churn. ')
    }
    try {
      if (mode === 'single') await coordinator.pullCrdtForNote(noteId)
      else await coordinator.pullCrdtForNotes([noteId])
    } finally {
      afterResponse.hook = null
    }
    coordinator.drainPendingPulls()
    return coordinatorLogs
      .filter((entry) => entry.message.startsWith('CRDT walk owed again'))
      .map((entry) => ({
        level: entry.level,
        ...(entry.meta as { noteId: string; owedWalksInARow: number })
      }))
      .filter((entry) => entry.noteId === noteId)
      .map((entry) => [entry.level, entry.owedWalksInARow])
  }

  it('logs a note owed again for a newer peer snapshot, and counts afresh once a walk settles it', async () => {
    const noteId = `churn-${randomUUID().slice(0, 8)}`
    await pushSnapshot(noteId, 'base. ')
    const coordinator = coordinatorOver(memoryProvider())

    expect(await churnPass(coordinator, noteId, isSnapshotGet)).toEqual([])
    expect(await churnPass(coordinator, noteId, isSnapshotGet)).toEqual([['debug', 2]])
    expect(await churnPass(coordinator, noteId)).toEqual([['debug', 2]])
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(false)

    // The probe proves the merged snapshot current, so the walk starts without
    // a GET; the update above it keeps the probe from settling the note.
    await pushUpdate(noteId, 'more. ')
    expect(await churnPass(coordinator, noteId, isProbe)).toEqual([['debug', 2]])
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
  }, 60_000)

  // The single-note pull sends no batch POST, so the passes below leave the
  // 30-per-minute batch bucket to the tests after them.
  it('logs the third owe in a row at info, since packaged builds drop debug lines', async () => {
    const noteId = `churn-info-${randomUUID().slice(0, 8)}`
    await pushSnapshot(noteId, 'base. ')
    const coordinator = coordinatorOver(memoryProvider())

    await churnPass(coordinator, noteId, isSnapshotGet, 'single')
    await churnPass(coordinator, noteId, isSnapshotGet, 'single')

    expect(await churnPass(coordinator, noteId, isSnapshotGet, 'single')).toEqual([
      ['debug', 2],
      ['info', 3]
    ])
  }, 60_000)

  it.each(['rowless', 'no longer synced'] as const)(
    'counts afresh for a note the pull drops as %s',
    async (how) => {
      const noteId = `churn-dropped-${randomUUID().slice(0, 8)}`
      await pushSnapshot(noteId, 'base. ')
      let hasRow = true
      const coordinator = coordinatorOver(memoryProvider(), false, () => hasRow)
      await churnPass(coordinator, noteId, isSnapshotGet, 'single')
      expect(await churnPass(coordinator, noteId, isSnapshotGet, 'single')).toEqual([['debug', 2]])

      if (how === 'rowless') {
        hasRow = false
        await coordinator.pullCrdtForNote(noteId)
        hasRow = true
      } else {
        coordinator.clearUnmergedForDroppedNote(noteId)
      }

      expect(await churnPass(coordinator, noteId, isSnapshotGet, 'single')).toEqual([['debug', 2]])
      expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
    },
    60_000
  )

  // #5286: a fresh device seeded 31 notes from markdown whose updates the
  // server returned, because the doc cache closed each doc mid-pass and the
  // closing doc refused the updates. The seed would push beside the server
  // body and duplicate it.
  const closeDocOn = (provider: MemoryProvider, noteId: string, method: string, limit?: number) => {
    afterResponse.hook = async (request) => {
      const body = request.body as { limit?: number } | undefined
      if (request.method !== method || !request.path.startsWith('/sync/crdt/updates')) return
      if (limit !== undefined && body?.limit !== limit) return
      afterResponse.hook = null
      provider.closing.add(noteId)
    }
  }

  it('never seeds an update-only note whose doc closed mid-pass on the single-note pull', async () => {
    const noteId = `closed-single-${randomUUID().slice(0, 8)}`
    await pushUpdate(noteId, 'server one. ')
    await pushUpdate(noteId, 'server two.')

    const provider = memoryProvider()
    const coordinator = coordinatorOver(provider)
    closeDocOn(provider, noteId, 'GET')
    try {
      await coordinator.pullCrdtForNote(noteId)
    } finally {
      afterResponse.hook = null
    }

    expect(provider.seeded).toEqual([])
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
    expect(coordinator.drainPendingPulls()).toContain(noteId)

    provider.closing.delete(noteId)
    await coordinator.pullCrdtForNote(noteId)

    expect(provider.seeded).toEqual([])
    expect(provider.text(noteId)).toBe('server one. server two.')
  }, 60_000)

  it('never seeds an update-only note whose doc closed mid-pass on the batch pull', async () => {
    const noteId = `closed-batch-${randomUUID().slice(0, 8)}`
    await pushUpdate(noteId, 'server one. ')
    await pushUpdate(noteId, 'server two.')

    const provider = memoryProvider()
    const coordinator = coordinatorOver(provider)
    closeDocOn(provider, noteId, 'POST', 100)
    try {
      await coordinator.pullCrdtForNotes([noteId])
    } finally {
      afterResponse.hook = null
    }

    expect(provider.seeded).toEqual([])
    expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
    expect(coordinator.drainPendingPulls()).toContain(noteId)

    provider.closing.delete(noteId)
    await coordinator.pullCrdtForNotes([noteId])

    expect(provider.seeded).toEqual([])
    expect(provider.text(noteId)).toBe('server one. server two.')
  }, 60_000)

  it('never seeds or settles a note whose server updates wait on a missing base', async () => {
    for (const mode of ['single', 'batch'] as const) {
      const noteId = `pending-${mode}-${randomUUID().slice(0, 8)}`
      const author = new Y.Doc()
      author.getText('body').insert(0, 'lost base. ')
      const base = Y.encodeStateVector(author)
      author.getText('body').insert(11, 'orphan delta.')
      const orphan = encryptCrdtUpdate(
        Y.encodeStateAsUpdate(author, base),
        vaultKey,
        noteId,
        signing.privateKey
      )
      await paced(() =>
        postToServer(
          '/sync/crdt/updates',
          { noteId, updates: [Buffer.from(orphan).toString('base64')] },
          token
        )
      )

      const provider = memoryProvider()
      const coordinator = coordinatorOver(provider)
      if (mode === 'single') await coordinator.pullCrdtForNote(noteId)
      else await coordinator.pullCrdtForNotes([noteId])

      expect(provider.seeded).toEqual([])
      expect(provider.text(noteId)).toBe('')
      expect(coordinator.hasUnmergedRemoteState(noteId)).toBe(true)
    }
  }, 60_000)

  it('still seeds a note the server holds no body for', async () => {
    const noteId = `bodyless-${randomUUID().slice(0, 8)}`
    const provider = memoryProvider()
    await coordinatorOver(provider).pullCrdtForNote(noteId)
    await coordinatorOver(provider).pullCrdtForNotes([`${noteId}-b`])

    expect(provider.seeded).toEqual([noteId, `${noteId}-b`])
  }, 60_000)
})
