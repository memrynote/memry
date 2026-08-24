import { describe, expect, it, vi } from 'vitest'
import { compressPayload } from '../compress.ts'
import { base64ToBytes, bytesToBase64 } from './base64.ts'
import { RecordPullEngine, sortByApplyOrder, type PullEngineDeps } from './engine.ts'
import type { SyncCryptoProvider } from './crypto-provider.ts'
import type { DecodedRecordItem, PullStore, RecordItemRef } from './store.ts'
import type { SyncHttpClient, SyncHttpRequest } from '../adapters/http-client.ts'
import type { SyncLogger } from '../adapters/logger.ts'

const encoder = new TextEncoder()

/** Crypto provider whose decrypt returns the ciphertext unchanged (tests build
 * "ciphertext" as compressPayload(json) so decompress round-trips). */
function fakeCrypto(overrides: Partial<SyncCryptoProvider> = {}): SyncCryptoProvider {
  return {
    unwrapFileKey: (wrapped) => wrapped,
    decrypt: (ciphertext) => ciphertext,
    verifyDetached: () => true,
    fromBase64: (value) => base64ToBytes(value),
    toBase64: (bytes) => bytesToBase64(bytes),
    ...overrides
  }
}

const silentLog: SyncLogger = { debug() {}, info() {}, warn() {}, error() {} }

function blobFor(payload: unknown): {
  encryptedKey: string
  keyNonce: string
  encryptedData: string
  dataNonce: string
} {
  const bytes = compressPayload(encoder.encode(JSON.stringify(payload)))
  return {
    encryptedKey: bytesToBase64(new Uint8Array([1, 2, 3])),
    keyNonce: bytesToBase64(new Uint8Array([4, 5, 6])),
    encryptedData: bytesToBase64(bytes),
    dataNonce: bytesToBase64(new Uint8Array([7, 8, 9]))
  }
}

interface Route {
  match: (req: SyncHttpRequest) => boolean
  respond: (req: SyncHttpRequest) => { status?: number; json: unknown }
}

function fakeHttp(routes: Route[]): SyncHttpClient & { calls: SyncHttpRequest[] } {
  const calls: SyncHttpRequest[] = []
  return {
    calls,
    async request(req) {
      calls.push(req)
      const route = routes.find((r) => r.match(req))
      if (!route) throw new Error(`no route for ${req.method} ${req.path}`)
      const { status = 200, json } = route.respond(req)
      return {
        status,
        headers: {},
        body: encoder.encode(JSON.stringify(json))
      }
    },
    onOnlineChanged: () => () => {},
    isMetered: async () => false
  }
}

function memoryStore(): PullStore & {
  cursor: string | null
  applied: DecodedRecordItem[][]
  refs: RecordItemRef[][]
  bareDeletes: string[][]
  corrupt: Array<{ id: string; reason: string }>
} {
  const state = {
    cursor: null as string | null,
    applied: [] as DecodedRecordItem[][],
    refs: [] as RecordItemRef[][],
    bareDeletes: [] as string[][],
    corrupt: [] as Array<{ id: string; reason: string }>,
    async getRecordCursor() {
      return state.cursor
    },
    async setRecordCursor(cursor: string) {
      state.cursor = cursor
    },
    async applyRecordRefs(refs: RecordItemRef[], bareDeleteIds: string[]) {
      state.refs.push(refs)
      state.bareDeletes.push(bareDeleteIds)
    },
    async applyRecordItems(items: DecodedRecordItem[]) {
      state.applied.push(items)
    },
    async markItemCorrupt(id: string, reason: string) {
      state.corrupt.push({ id, reason })
    }
  }
  return state
}

const DEVICE_ID = 'device-1'
const devicesRoute: Route = {
  match: (req) => req.path === '/auth/devices',
  respond: () => ({
    json: {
      devices: [
        {
          id: DEVICE_ID,
          name: 'Desk',
          platform: 'desktop',
          signingPublicKey: bytesToBase64(new Uint8Array(32).fill(7)),
          revokedAt: null
        }
      ]
    }
  })
}

function pullItem(id: string, type: string, payload: unknown, extra: Record<string, unknown> = {}) {
  return {
    id,
    type,
    operation: 'update',
    signature: bytesToBase64(new Uint8Array(64)),
    signerDeviceId: DEVICE_ID,
    blob: blobFor(payload),
    ...extra
  }
}

function makeEngine(
  http: SyncHttpClient,
  store: PullStore,
  overrides: Partial<PullEngineDeps> = {}
): RecordPullEngine {
  return new RecordPullEngine({
    http,
    crypto: fakeCrypto(),
    store,
    vaultId: 'vault-1',
    clientHeaderValue: 'ios/0.1.0+1',
    getAccessToken: () => 'token-a',
    getVaultKey: () => new Uint8Array(32),
    log: silentLog,
    ...overrides
  })
}

describe('RecordPullEngine.pullIncremental', () => {
  it('applies pages, unions deleted ids into the pull, advances cursor after apply', async () => {
    const store = memoryStore()
    const pullBodies: string[][] = []
    const http = fakeHttp([
      devicesRoute,
      {
        match: (req) => req.path.startsWith('/sync/changes'),
        respond: (req) =>
          req.path.includes('cursor=7')
            ? { json: { items: [], deleted: [], hasMore: false, nextCursor: 7 } }
            : {
                json: {
                  items: [
                    { id: 'n1', type: 'note', version: 1, modifiedAt: 10, size: 5 },
                    { id: 't1', type: 'task', version: 1, modifiedAt: 11, size: 5 }
                  ],
                  deleted: ['gone-1'],
                  hasMore: true,
                  nextCursor: 7
                }
              }
      },
      {
        match: (req) => req.path === '/sync/pull',
        respond: (req) => {
          const body = JSON.parse(String(req.body)) as { itemIds: string[] }
          pullBodies.push(body.itemIds)
          return {
            json: {
              items: [
                pullItem('t1', 'task', { title: 'task', clock: {} }, { clock: { d: 1 } }),
                pullItem('n1', 'note', { title: 'hello', fileType: 'markdown' }),
                pullItem('gone-1', 'note', {}, { deletedAt: 123 })
              ]
            }
          }
        }
      }
    ])

    const engine = makeEngine(http, store)
    const result = await engine.pullIncremental()

    expect(result.ok).toBe(true)
    expect(pullBodies[0]).toEqual(['n1', 't1', 'gone-1'])
    expect(store.cursor).toBe('7')
    expect(store.applied).toHaveLength(1)
    const applied = store.applied[0]
    // FK-parent order: note (rank 1) before task (rank 2); delete decoded without body
    expect(applied.map((i) => i.id)).toEqual(['n1', 'gone-1', 't1'])
    const tombstone = applied.find((i) => i.id === 'gone-1')
    expect(tombstone?.operation).toBe('delete')
    expect(tombstone?.payloadJson).toBeUndefined()
    expect(result.changedNoteIds).toEqual(['n1'])
    expect(result.itemsApplied).toBe(3)
  })

  it('skips a malformed item without poisoning its page-mates', async () => {
    const store = memoryStore()
    const http = fakeHttp([
      devicesRoute,
      {
        match: (req) => req.path.startsWith('/sync/changes'),
        respond: (req) =>
          req.path.includes('cursor=5')
            ? { json: { items: [], deleted: [], hasMore: false, nextCursor: 5 } }
            : {
                json: {
                  items: [
                    { id: 'bad1', type: 'note', version: 1, modifiedAt: 1, size: 1 },
                    { id: 'ok1', type: 'note', version: 1, modifiedAt: 2, size: 1 }
                  ],
                  deleted: [],
                  hasMore: true,
                  nextCursor: 5
                }
              }
      },
      {
        match: (req) => req.path === '/sync/pull',
        respond: () => ({
          json: {
            items: [
              { id: 'bad1', nonsense: true },
              pullItem('ok1', 'note', { title: 'survives', fileType: 'markdown' })
            ]
          }
        })
      }
    ])

    const engine = makeEngine(http, store)
    const result = await engine.pullIncremental()

    expect(result.ok).toBe(true)
    expect(store.applied.flat().map((i) => i.id)).toEqual(['ok1'])
    expect(store.corrupt).toHaveLength(1)
    expect(store.corrupt[0].id).toBe('bad1')
    expect(store.corrupt[0].reason).toContain('schema')
    expect(store.cursor).toBe('5')
  })

  it('drops a page whose response is not a pull envelope but still advances the cursor', async () => {
    const store = memoryStore()
    const http = fakeHttp([
      devicesRoute,
      {
        match: (req) => req.path.startsWith('/sync/changes'),
        respond: (req) =>
          req.path.includes('cursor=5')
            ? { json: { items: [], deleted: [], hasMore: false, nextCursor: 5 } }
            : {
                json: {
                  items: [{ id: 'x1', type: 'note', version: 1, modifiedAt: 1, size: 1 }],
                  deleted: [],
                  hasMore: true,
                  nextCursor: 5
                }
              }
      },
      {
        match: (req) => req.path === '/sync/pull',
        respond: () => ({ json: { error: 'not an envelope' } })
      }
    ])

    const engine = makeEngine(http, store)
    const result = await engine.pullIncremental()

    expect(result.ok).toBe(true)
    expect(store.applied).toHaveLength(0)
    expect(store.cursor).toBe('5')
  })

  it('breaker: a fully undecryptable page advances the cursor, marks corrupt, refuses the run', async () => {
    const store = memoryStore()
    const http = fakeHttp([
      devicesRoute,
      {
        match: (req) => req.path.startsWith('/sync/changes'),
        respond: () => ({
          json: {
            items: [{ id: 'p1', type: 'note', version: 1, modifiedAt: 1, size: 1 }],
            deleted: [],
            hasMore: true,
            nextCursor: 9
          }
        })
      },
      {
        match: (req) => req.path === '/sync/pull',
        respond: () => ({ json: { items: [pullItem('p1', 'note', { t: 1 })] } })
      }
    ])

    const engine = makeEngine(http, store, {
      crypto: fakeCrypto({ verifyDetached: () => false })
    })
    const result = await engine.pullIncremental()

    expect(result.refused).toBe('breaker')
    expect(result.ok).toBe(false)
    expect(store.cursor).toBe('9')
    expect(store.corrupt).toHaveLength(1)
    expect(store.corrupt[0]).toMatchObject({ id: 'p1' })
    expect(store.applied).toHaveLength(0)
  })

  it('refuses without credentials and touches nothing', async () => {
    const store = memoryStore()
    const http = fakeHttp([])
    const engine = makeEngine(http, store, { getVaultKey: () => null })
    const result = await engine.pullIncremental()
    expect(result.refused).toBe('no-credentials')
    expect(http.calls).toHaveLength(0)
    expect(store.cursor).toBeNull()
  })

  it('sends auth, vault, sync-types and x-memry-client headers on every request', async () => {
    const store = memoryStore()
    const http = fakeHttp([
      devicesRoute,
      {
        match: (req) => req.path.startsWith('/sync/changes'),
        respond: () => ({ json: { items: [], deleted: [], hasMore: false, nextCursor: 0 } })
      }
    ])
    const engine = makeEngine(http, store)
    await engine.pullIncremental()

    const req = http.calls.find((c) => c.path.startsWith('/sync/changes'))
    expect(req?.headers?.Authorization).toBe('Bearer token-a')
    expect(req?.headers?.['X-Memry-Vault-Id']).toBe('vault-1')
    expect(req?.headers?.['x-memry-client']).toBe('ios/0.1.0+1')
    expect(req?.headers?.['X-Memry-Sync-Types']).toContain('note')
    expect(req?.headers?.['X-Memry-Sync-Types']).toContain('home_page')
  })

  it('on a 401 refreshes once and retries with the new token', async () => {
    const store = memoryStore()
    let served401 = false
    const http = fakeHttp([
      devicesRoute,
      {
        match: (req) => req.path.startsWith('/sync/changes'),
        respond: (req) => {
          if (!served401 && req.headers?.Authorization === 'Bearer token-a') {
            served401 = true
            return { status: 401, json: { error: { code: 'AUTH_EXPIRED', message: 'expired' } } }
          }
          return { json: { items: [], deleted: [], hasMore: false, nextCursor: 0 } }
        }
      }
    ])
    const refresh = vi.fn(async () => 'token-b')
    const engine = makeEngine(http, store, { refreshAccessToken: refresh })
    const result = await engine.pullIncremental()

    expect(result.ok).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
    const retried = http.calls.filter((c) => c.path.startsWith('/sync/changes'))
    expect(retried.at(-1)?.headers?.Authorization).toBe('Bearer token-b')
  })
})

describe('RecordPullEngine.pullRefsToEnd', () => {
  it('stores refs and bare deletes page by page, advancing the cursor', async () => {
    const store = memoryStore()
    const http = fakeHttp([
      {
        match: (req) => req.path.startsWith('/sync/changes'),
        respond: (req) =>
          req.path.includes('cursor=3')
            ? { json: { items: [], deleted: [], hasMore: false, nextCursor: 3 } }
            : {
                json: {
                  items: [{ id: 'a', type: 'note', version: 2, modifiedAt: 100, size: 42 }],
                  deleted: ['a', 'zombie'],
                  hasMore: true,
                  nextCursor: 3
                }
              }
      }
    ])
    const engine = makeEngine(http, store)
    const { refs } = await engine.pullRefsToEnd()

    expect(refs).toBe(2)
    expect(store.refs[0]).toEqual([
      { id: 'a', type: 'note', modifiedAt: 100, size: 42, deleted: true }
    ])
    expect(store.bareDeletes[0]).toEqual(['zombie'])
    expect(store.cursor).toBe('3')
  })
})

describe('sortByApplyOrder', () => {
  it('ranks FK parents first and calendar_binding last', () => {
    const sorted = sortByApplyOrder([
      { type: 'calendar_binding' },
      { type: 'task' },
      { type: 'note' },
      { type: 'project' }
    ])
    expect(sorted.map((s) => s.type)).toEqual(['project', 'note', 'task', 'calendar_binding'])
  })
})
