import { describe, expect, it } from 'vitest'
import { compressPayload } from '../compress.ts'
import { base64ToBytes, bytesToBase64 } from './base64.ts'
import { CrdtBodyPuller, type CrdtPullDeps } from './crdt-pull.ts'
import type { SyncCryptoProvider } from './crypto-provider.ts'
import type { CrdtPullStore } from './store.ts'
import type { SyncHttpClient, SyncHttpRequest } from '../adapters/http-client.ts'
import type { SyncLogger } from '../adapters/logger.ts'
import type { SeamHttpContext } from './http.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const silentLog: SyncLogger = { debug() {}, info() {}, warn() {}, error() {} }

const NONCE = 24
const WRAPPED = 48
const SIG = 64
const HEADER = NONCE + NONCE + WRAPPED + SIG

/** Pack plaintext in the CRDT wire layout the fake crypto can unwrap. */
function packUpdate(plaintext: string): string {
  const ciphertext = compressPayload(encoder.encode(plaintext))
  const packed = new Uint8Array(HEADER + ciphertext.length)
  packed.set(ciphertext, HEADER)
  return bytesToBase64(packed)
}

const fakeCrypto: SyncCryptoProvider = {
  unwrapFileKey: (wrapped) => wrapped,
  decrypt: (ciphertext) => ciphertext,
  verifyDetached: () => true,
  fromBase64: (value) => base64ToBytes(value),
  toBase64: (bytes) => bytesToBase64(bytes)
}

function fakeHttp(
  handler: (req: SyncHttpRequest) => unknown
): SyncHttpClient & { calls: SyncHttpRequest[] } {
  const calls: SyncHttpRequest[] = []
  return {
    calls,
    async request(req) {
      calls.push(req)
      return { status: 200, headers: {}, body: encoder.encode(JSON.stringify(handler(req))) }
    },
    onOnlineChanged: () => () => {},
    isMetered: async () => false
  }
}

function memoryCrdtStore(): CrdtPullStore & {
  since: Map<string, number>
  updates: Array<{ noteId: string; seq: number; text: string }>
  snapshots: Array<{ noteId: string; seq: number; text: string; revision: string | null }>
} {
  const state = {
    since: new Map<string, number>(),
    revisions: new Map<string, string | null>(),
    updates: [] as Array<{ noteId: string; seq: number; text: string }>,
    snapshots: [] as Array<{ noteId: string; seq: number; text: string; revision: string | null }>,
    async getNoteSince(noteId: string) {
      return state.since.get(noteId) ?? 0
    },
    async setNoteSince(noteId: string, seq: number) {
      state.since.set(noteId, seq)
    },
    async getSnapshotRevision(noteId: string) {
      return state.revisions.get(noteId) ?? null
    },
    async saveSnapshot(
      noteId: string,
      snapshot: Uint8Array,
      upToSeq: number,
      revision: string | null
    ) {
      state.snapshots.push({ noteId, seq: upToSeq, text: decoder.decode(snapshot), revision })
      state.revisions.set(noteId, revision)
    },
    async appendUpdate(noteId: string, update: Uint8Array, serverSeq: number) {
      state.updates.push({ noteId, seq: serverSeq, text: decoder.decode(update) })
    }
  }
  return state
}

function makePuller(
  http: SyncHttpClient,
  store: CrdtPullStore,
  overrides: Partial<CrdtPullDeps> = {}
): CrdtBodyPuller {
  const httpCtx: SeamHttpContext = {
    http,
    accessToken: () => 'token',
    vaultId: 'vault-1',
    clientHeaderValue: 'ios/0.1.0+1'
  }
  return new CrdtBodyPuller({
    httpCtx: () => httpCtx,
    crypto: fakeCrypto,
    store,
    resolveDeviceKey: async () => new Uint8Array(32),
    getVaultKey: () => new Uint8Array(32),
    log: silentLog,
    ...overrides
  })
}

describe('CrdtBodyPuller', () => {
  it('cold note: snapshot baseline then incrementals, watermark follows server seq', async () => {
    const store = memoryCrdtStore()
    const http = fakeHttp((req) => {
      if (req.path === '/sync/crdt/updates/batch') {
        return {
          notes: {
            n1: {
              updates: [
                { sequenceNum: 6, data: packUpdate('u6'), createdAt: 1, signerDeviceId: 'd1' }
              ],
              hasMore: false
            }
          },
          snapshotMeta: { n1: { sequenceNum: 5, revision: 'rev-a', signerDeviceId: 'd1' } }
        }
      }
      if (req.path.startsWith('/sync/crdt/snapshot/')) {
        return {
          snapshot: packUpdate('snap'),
          sequenceNum: 5,
          signerDeviceId: 'd1',
          revision: 'rev-a'
        }
      }
      if (req.path.startsWith('/sync/crdt/updates?')) {
        return {
          updates: [{ sequenceNum: 6, data: packUpdate('u6'), createdAt: 1, signerDeviceId: 'd1' }],
          hasMore: false
        }
      }
      throw new Error(`unexpected ${req.path}`)
    })

    const changedNotes: string[] = []
    const puller = makePuller(http, store, {
      onNoteBodyChanged: (id) => void changedNotes.push(id)
    })
    const result = await puller.pullBodies(['n1'])

    expect(result).toEqual({ notesUpdated: 1, notesFailed: 0 })
    expect(store.snapshots).toEqual([{ noteId: 'n1', seq: 5, text: 'snap', revision: 'rev-a' }])
    expect(store.updates).toEqual([{ noteId: 'n1', seq: 6, text: 'u6' }])
    expect(store.since.get('n1')).toBe(6)
    expect(changedNotes).toEqual(['n1'])
  })

  it('warm note with matching revision skips the baseline and applies batch updates', async () => {
    const store = memoryCrdtStore()
    store.since.set('n1', 5)
    await store.saveSnapshot('n1', new Uint8Array(), 5, 'rev-a')
    store.snapshots.length = 0

    const http = fakeHttp((req) => {
      if (req.path === '/sync/crdt/updates/batch') {
        return {
          notes: {
            n1: {
              updates: [
                { sequenceNum: 7, data: packUpdate('u7'), createdAt: 1, signerDeviceId: 'd1' }
              ],
              hasMore: false
            }
          },
          snapshotMeta: { n1: { sequenceNum: 5, revision: 'rev-a', signerDeviceId: 'd1' } }
        }
      }
      throw new Error(`unexpected ${req.path}`)
    })

    const puller = makePuller(http, store)
    const result = await puller.pullBodies(['n1'])

    expect(result.notesUpdated).toBe(1)
    expect(store.snapshots).toHaveLength(0)
    expect(store.updates.map((u) => u.seq)).toEqual([7])
    expect(store.since.get('n1')).toBe(7)
  })

  it('stops at an unresolvable signer without advancing the watermark past it', async () => {
    const store = memoryCrdtStore()
    store.since.set('n1', 5)
    await store.saveSnapshot('n1', new Uint8Array(), 5, 'rev-a')

    const http = fakeHttp((req) => {
      if (req.path === '/sync/crdt/updates/batch') {
        return {
          notes: {
            n1: {
              updates: [
                { sequenceNum: 6, data: packUpdate('u6'), createdAt: 1, signerDeviceId: 'ghost' },
                { sequenceNum: 7, data: packUpdate('u7'), createdAt: 1, signerDeviceId: 'd1' }
              ],
              hasMore: false
            }
          },
          snapshotMeta: { n1: { sequenceNum: 5, revision: 'rev-a', signerDeviceId: 'd1' } }
        }
      }
      throw new Error(`unexpected ${req.path}`)
    })

    const puller = makePuller(http, store, {
      resolveDeviceKey: async (id) => (id === 'ghost' ? null : new Uint8Array(32))
    })
    const result = await puller.pullBodies(['n1'])

    expect(store.updates).toHaveLength(0)
    expect(store.since.get('n1')).toBe(5)
    expect(result.notesFailed).toBe(0)
  })
})
