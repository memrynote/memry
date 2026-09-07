import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The `runSync` call site, not the helper it calls.
 *
 * `convergence.test.ts` proves `bodyPullTargets` computes the right union and
 * that a body pulled for an open note decrypts and merges. It cannot prove the
 * sync pass ASKS for that union, because it calls the helper itself. Replacing
 * the whole fix with `const targets = [...record.changedNoteIds]` leaves that
 * file green, which makes it a test of the helper rather than of the bug.
 *
 * This drives the real `MobileSyncEngine.runSync`. The mocks are the modules
 * that reach native — `@react-native-community/netinfo` is imported at module
 * scope by the http client, expo-sqlite by the db, expo-secure-store by the
 * keychain — plus the two pull engines, which are the seam the assertion reads.
 * Everything between the record pull and the body pull is the shipped code.
 */

const state = vi.hoisted(() => ({
  changedNoteIds: [] as string[],
  openDocIds: [] as string[],
  pullBodiesCalls: [] as string[][]
}))

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => {},
    fetch: async () => ({ isConnected: true, isInternetReachable: true })
  }
}))

vi.mock('@memry/sync-client/pull', () => ({
  buildClientHeaderValue: () => 'ios/1.0.0',
  seamJsonRequest: async () => ({ devices: [] }),
  RecordPullEngine: class {
    async pullIncremental() {
      return { ok: true, itemsApplied: 0, changedNoteIds: state.changedNoteIds }
    }
    async fetchStatus() {
      return null
    }
  },
  CrdtBodyPuller: class {
    async pullBodies(noteIds: string[]) {
      state.pullBodiesCalls.push([...noteIds])
      return { notesUpdated: noteIds.length }
    }
  }
}))

vi.mock('../../adapters/http-client', () => ({
  createMobileHttpClient: () => ({
    request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    onOnlineChanged: () => () => {},
    isMetered: async () => false
  })
}))
vi.mock('../../adapters/runtime', () => ({ mobileAppVersion: () => '1.0.0' }))
vi.mock('../../db/index', () => ({ openVaultDb: async () => ({}) }))
vi.mock('../../db/pull-store', () => ({ MobilePullStore: class {} }))
vi.mock('../../lib/secure-store', () => ({ getVaultKey: async () => new Uint8Array(32) }))
vi.mock('../auth-client', () => ({
  loadSession: async () => ({ accessToken: 'access-token' }),
  refreshSession: async () => 'access-token'
}))
vi.mock('../crypto-provider', () => ({ createMobileCryptoProvider: () => ({}) }))
vi.mock('../sync-state', () => ({ recordSyncOutcome: async () => {} }))
vi.mock('../note-materializer', () => ({ materializeNoteBody: async () => {} }))

// The registry lookup is stubbed, not the union. What is under test is whether
// the pass consults the open docs at all, so the assertion has to be able to
// see an open note without standing up a whole editor session.
vi.mock('../../editor/session', () => ({ openDocIdsFor: async () => state.openDocIds }))

const { MobileSyncEngine } = await import('../engine')

beforeEach(() => {
  state.changedNoteIds = []
  state.openDocIds = []
  state.pullBodiesCalls = []
})

describe('the body-pull set a sync pass asks for', () => {
  it('includes an open note the record feed never named', async () => {
    // A peer edited only the body, so the change feed carries no record row for
    // it. This is the precondition the whole defect rests on.
    state.changedNoteIds = []
    state.openDocIds = ['note-open-on-the-phone']

    const summary = await new MobileSyncEngine('vault-1').sync()

    expect(state.pullBodiesCalls).toEqual([['note-open-on-the-phone']])
    // And it is reported, or the editor showing that note keeps painting the
    // old text even though the new body is now on disk.
    expect(summary.changedNoteIds).toEqual(['note-open-on-the-phone'])
  })

  it('is the union of the feed and the open docs, deduplicated', async () => {
    state.changedNoteIds = ['note-from-feed', 'note-both']
    state.openDocIds = ['note-both', 'note-open']

    await new MobileSyncEngine('vault-2').sync()

    expect(state.pullBodiesCalls).toEqual([['note-from-feed', 'note-both', 'note-open']])
  })

  it('asks for nothing when the feed is empty and no doc is open', async () => {
    state.changedNoteIds = []
    state.openDocIds = []

    await new MobileSyncEngine('vault-3').sync()

    // An empty set short-circuits before the puller is constructed, so "no
    // call" is the correct observation rather than a call with no ids.
    expect(state.pullBodiesCalls).toEqual([])
  })
})
