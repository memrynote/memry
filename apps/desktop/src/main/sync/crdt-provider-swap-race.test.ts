import * as Y from 'yjs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The seam (#3095): right after the outside-vault check resolves a note file,
// the file is swapped for a link to a file outside the vault, before it is read.
const race = vi.hoisted(() => ({ target: '', swap: (): void => {} }))

function swapOnce(probe: unknown): void {
  if (race.target === '' || probe !== race.target) return
  race.target = ''
  race.swap()
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const realpath = async (probe: string): Promise<string> => {
    const real = await actual.realpath(probe)
    swapOnce(probe)
    return real
  }
  return { ...actual, default: { ...actual, realpath }, realpath }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const native = (probe: string): string => {
    const real = actual.realpathSync.native(probe)
    swapOnce(probe)
    return real
  }
  const realpathSync = Object.assign((probe: string) => actual.realpathSync(probe), { native })
  return { ...actual, default: { ...actual, realpathSync }, realpathSync }
})

const mocks = vi.hoisted(() => ({
  vaultRoot: '',
  owed: new Set<string>(),
  cleared: [] as string[],
  taken: [] as string[]
}))

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getVersion: () => '2026.9.14' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] }
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('./crdt-preflight', () => ({
  runCrdtPreflight: vi.fn(async () => ({ ok: true })),
  preflightMachineFields: () => ({}),
  stripAbsolutePaths: (text: string) => text
}))
vi.mock('y-leveldb', () => ({
  LeveldbPersistence: class {
    getYDoc = vi.fn(async (noteId: string) => new Y.Doc({ guid: `${noteId}:persisted` }))
    clearDocument = vi.fn(async () => undefined)
    destroy = vi.fn(async () => {})
    storeUpdate = vi.fn(async () => undefined)
    flushDocument = vi.fn(async () => undefined)
    getMeta = vi.fn(async () => undefined)
    setMeta = vi.fn(async () => {})
  }
}))
vi.mock('./crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => false }))
vi.mock('../database/client', () => ({
  getIndexDatabase: () => ({ kind: 'index-db' }),
  getDatabase: () => ({}),
  isDatabaseInitialized: () => true
}))
vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: () => '11111111-2222-3333-4444-555555555555'
}))
vi.mock('../store', () => ({
  getLegacyCrdtStoreClaim: () => undefined,
  recordLegacyCrdtStoreClaim: vi.fn(),
  getVaults: () => [],
  getLegacyCrdtStorePartitionPending: () => undefined,
  clearLegacyCrdtStorePartitionPending: vi.fn(),
  getPendingCrdtStoreRename: () => undefined,
  clearPendingCrdtStoreRename: vi.fn(),
  getCrdtInMemorySessions: () => 0,
  getCrdtPersistenceGuard: () => ({ sessions: 0 }),
  recordCrdtPersistenceOutcome: () => 0,
  recordCrdtPreflightFailure: vi.fn()
}))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (_db: unknown, id: string) => ({
    id,
    path: `notes/${id}.md`,
    title: id,
    fileType: 'markdown'
  }),
  updateNoteCache: vi.fn()
}))
vi.mock('../database', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => ({ kind: 'index-db' })
}))
vi.mock('@memry/storage-data', () => ({ updateNoteMetadata: vi.fn() }))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))
vi.mock('@memry/sync-client/attachment-events', () => ({
  attachmentEvents: { emitSaved: vi.fn() }
}))
vi.mock('../tasks/domain', () => ({ createDesktopTasksDomain: vi.fn() }))
vi.mock('../tasks/publisher', () => ({ createTasksPublisher: vi.fn() }))
vi.mock('../lib/id', () => ({ generateId: vi.fn(() => 'generated-id') }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => mocks.vaultRoot,
  toAbsolutePath: (p: string) => path.join(mocks.vaultRoot, p)
}))
// safeRead is the real read, so a path-based read follows the swapped link.
vi.mock('../vault/file-ops', () => ({
  safeRead: async (file: string) => fs.readFileSync(file, 'utf-8')
}))
vi.mock('../vault/frontmatter', () => ({
  parseNote: (raw: string) => ({ content: raw, frontmatter: {} }),
  serializeNote: vi.fn(),
  serializeParsedNote: vi.fn(),
  generateContentHash: (content: unknown) => `hash:${String(content)}`
}))
vi.mock('./blocknote-converter', () => ({
  markdownToYFragment: async (content: string, fragment: Y.XmlFragment) => {
    fragment.insert(0, [new Y.XmlText(content)])
    return true
  },
  repairEmptyBlockIds: () => 0
}))
vi.mock('@memry/sync-client/crdt-compact-utils', () => ({ compactYDoc: () => null }))
vi.mock('./crdt-writeback', () => ({
  scheduleWriteback: vi.fn(),
  cancelWriteback: vi.fn(),
  flushPendingWritebacks: vi.fn(),
  recordNetworkUpdate: vi.fn(),
  resetWritebackState: vi.fn(),
  writebackNow: vi.fn()
}))
vi.mock('@memry/sync-client/microtask-batch-broadcaster', () => ({
  MicrotaskBatchBroadcaster: class {
    enqueue = vi.fn()
    flush = vi.fn()
    flushAll = vi.fn()
  }
}))
// takeOwedFile's feed is observed instead of run: whatever raw it receives
// would have been merged into the doc.
vi.mock('./crdt-external-feed', () => ({
  takeOwedFile: async (_id: string, doc: Y.Doc, file: { raw: string }) => {
    mocks.taken.push(file.raw)
    doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText(file.raw)])
    return true
  }
}))
vi.mock('./crdt-owed-file-body', () => ({
  owesFileBody: (id: string) => mocks.owed.has(id),
  clearOwedFileBody: (id: string) => {
    mocks.cleared.push(id)
    mocks.owed.delete(id)
  },
  recordOwedFileBody: (id: string) => mocks.owed.add(id)
}))

import { CrdtProvider, resetCrdtProvider } from './crdt-provider'
import type { SnapshotPushFn } from './crdt-provider'

const isWindows = process.platform === 'win32'

describe('a note file swapped for an outside link after the vault check (#3095)', () => {
  let outside: string
  let secret: string
  let provider: CrdtProvider

  function arm(noteId: string): void {
    const file = path.join(mocks.vaultRoot, 'notes', `${noteId}.md`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'vault text\n')
    race.target = file
    race.swap = () => {
      fs.rmSync(file)
      fs.symlinkSync(secret, file)
    }
  }

  const docText = (doc: Y.Doc): string => doc.getXmlFragment('prosemirror').toString()

  beforeEach(async () => {
    mocks.vaultRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-vault-')))
    mocks.owed.clear()
    mocks.cleared = []
    mocks.taken = []
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-swap-outside-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, 'outside secret\n')
    provider = new CrdtProvider()
    await provider.init(
      { enqueue: vi.fn(), enqueueFullState: vi.fn(), dropNote: vi.fn() } as never,
      vi.fn<SnapshotPushFn>().mockResolvedValue(undefined)
    )
  })

  afterEach(() => {
    race.target = ''
    resetCrdtProvider()
    fs.rmSync(mocks.vaultRoot, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it.skipIf(isWindows)('seeding never puts the outside bytes in the doc', async () => {
    await provider.open('seeded', undefined, { skipSeed: true })
    arm('seeded')
    await provider.seedFromMarkdownPublic('seeded').catch(() => undefined)
    expect(docText(provider.getDoc('seeded')!)).not.toContain('outside secret')
  })

  it.skipIf(isWindows)(
    'taking an owed file never merges the outside bytes and keeps the file owed',
    async () => {
      await provider.open('owed', undefined, { skipSeed: true })
      const doc = provider.getDoc('owed')!
      doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('server body')])
      mocks.owed.add('owed')
      arm('owed')
      await provider.takeFileAfterMerge('owed', doc).catch(() => false)
      expect(mocks.taken.join('')).not.toContain('outside secret')
      expect(docText(doc)).not.toContain('outside secret')
      expect(mocks.cleared).not.toContain('owed')
      expect(mocks.owed.has('owed')).toBe(true)
    }
  )
})
