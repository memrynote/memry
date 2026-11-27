import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { getNoteCacheById, insertNoteCache, updateNoteCache } from '@main/database/queries/notes'
import * as Y from 'yjs'
import { generateContentHash } from '../vault/frontmatter'
import { folderLockedError } from '../vault-locks/registry'
import {
  baselineAfterWrite,
  baselineBeforeFeed,
  isOutsideEdit,
  landBodyEdit,
  markDocWrite,
  recordDocFile,
  takesUnstoredFile,
  writeDocWithBaseline,
  writeWithBaseline,
  type DocStore
} from './writeback-baseline'

const retryWriteback = vi.hoisted(() => vi.fn())
vi.mock('./crdt-writeback-port', () => ({ crdtWriteback: () => ({ retryWriteback }) }))

const A = '# Log\n\nFirst line.\n'
const B = '# Log\n\nFirst line. Second.\n'
const row = {
  id: 'n1',
  path: 'a.md',
  title: 'a',
  fileType: 'markdown' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  modifiedAt: '2026-01-01T00:00:00.000Z'
}

/**
 * A write-back that crashed after its file write leaves the bytes it wrote as
 * its pending hash. A cache write that keeps the hash it found must keep that
 * record, or recovery reads Memry's own bytes as an outside edit (#5296 I2a).
 */
describe('the write-ahead record of a crashed write-back', () => {
  let index: TestDatabaseResult
  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
  })
  afterEach(() => index.close())
  const cached = () => getNoteCacheById(index.db, 'n1')!

  async function crashAfterWrite(during: () => void): Promise<void> {
    await writeWithBaseline(index.db, 'n1', B, async () => {
      during()
      throw new Error('crash after the file write')
    }).catch(() => {})
  }

  it('survives a projection of the same hash that lands during the write', async () => {
    await crashAfterWrite(() =>
      updateNoteCache(index.db, 'n1', { contentHash: generateContentHash(A), title: 'a' })
    )
    expect(cached().pendingWriteHash).toBe(generateContentHash(B))
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(false)
  })

  it('survives a re-upsert that keeps the same hash after the crash', async () => {
    await crashAfterWrite(() => {})
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(false)
  })
})

describe('the clear rule of the pending hash', () => {
  let index: TestDatabaseResult
  beforeEach(() => {
    index = createTestIndexDb()
  })
  afterEach(() => index.close())
  const pending = () => getNoteCacheById(index.db, 'n1')!.pendingWriteHash

  it('keeps a pending hash when a NULL hash is written over NULL', () => {
    insertNoteCache(index.db, { ...row, contentHash: null })
    updateNoteCache(index.db, 'n1', { pendingWriteHash: 'p' })
    updateNoteCache(index.db, 'n1', { contentHash: null, title: 'b' })
    insertNoteCache(index.db, { ...row, contentHash: null })
    expect(pending()).toBe('p')
  })

  it('keeps a pending hash when a write omits the hash', () => {
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
    updateNoteCache(index.db, 'n1', { pendingWriteHash: 'p' })
    updateNoteCache(index.db, 'n1', { contentHash: undefined, title: 'b' })
    insertNoteCache(index.db, { ...row })
    expect(pending()).toBe('p')
    expect(getNoteCacheById(index.db, 'n1')!.contentHash).toBe(generateContentHash(A))
  })
})

/**
 * Memry's own body edit lands in the doc first, then in the file through
 * `writeWithBaseline` (D-DOC-FIRST, #5304). A doc that does not take the edit
 * still gets the file written, with the baseline kept, so the write-back reads
 * the file as an outside edit and feeds it at open.
 */
describe("Memry's own body edit (landBodyEdit)", () => {
  let index: TestDatabaseResult
  let disk: string
  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
    disk = A
  })
  afterEach(() => index.close())
  const cached = () => getNoteCacheById(index.db, 'n1')!
  const write = async (): Promise<void> => {
    disk = B
  }

  it('publishes the baseline it finds for bytes the doc does not hold', () => {
    expect(baselineBeforeFeed(index.db, 'n1', B)).toBe(generateContentHash(A))
  })

  it('writes the file and records it once the doc took the edit', async () => {
    const order: string[] = []
    const published = await landBodyEdit(index.db, 'n1', B, {
      notePath: 'a.md',
      feed: async () => (order.push('feed'), true),
      write: async () => (order.push('write'), write())
    })
    expect(order).toEqual(['feed', 'write'])
    expect(disk).toBe(B)
    expect(published).toBe(generateContentHash(B))
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(false)
  })

  it('writes the file and keeps the baseline when the doc declines', async () => {
    const published = await landBodyEdit(index.db, 'n1', B, {
      notePath: 'a.md',
      feed: async () => false,
      write
    })
    expect(disk).toBe(B)
    expect(published).toBe(generateContentHash(A))
    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(true)
  })

  it('throws with no file written and the baseline kept when the feed throws', async () => {
    await expect(
      landBodyEdit(index.db, 'n1', B, {
        notePath: 'a.md',
        feed: async () => {
          throw new Error('store failed')
        },
        write
      })
    ).rejects.toThrow('store failed')
    expect(disk).toBe(A)
    expect(cached().contentHash).toBe(generateContentHash(A))
  })

  it('a full-body writer throws with the baseline kept and retries through the write-back when the write fails after the feed', async () => {
    retryWriteback.mockClear()
    await expect(
      landBodyEdit(index.db, 'n1', B, {
        notePath: 'a.md',
        feed: async () => true,
        write: async () => {
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
        }
      })
    ).rejects.toThrow('EBUSY')
    expect(disk).toBe(A)
    expect(cached().contentHash).toBe(generateContentHash(A))
    expect(retryWriteback).toHaveBeenCalledWith('n1')
  })

  // The doc holds the edit, so the caller must not keep a second copy.
  it('an append resolves with the baseline kept and retries through the write-back when the write fails after the feed', async () => {
    retryWriteback.mockClear()
    const published = await landBodyEdit(index.db, 'n1', B, {
      notePath: 'a.md',
      appends: true,
      feed: async () => true,
      write: async () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      }
    })
    expect(disk).toBe(A)
    expect(published).toBe(generateContentHash(A))
    expect(isOutsideEdit(index.db, 'n1', cached(), A)).toBe(false)
    expect(retryWriteback).toHaveBeenCalledWith('n1')
  })

  it('an append still throws a lock refusal of the write after the feed', async () => {
    retryWriteback.mockClear()
    await expect(
      landBodyEdit(index.db, 'n1', B, {
        notePath: 'a.md',
        appends: true,
        feed: async () => true,
        write: async () => {
          throw folderLockedError()
        }
      })
    ).rejects.toThrow(folderLockedError().message)
    expect(retryWriteback).not.toHaveBeenCalled()
  })

  // A crash between the file write and the record: the pending hash names the
  // bytes, so recovery reads them as Memry's own.
  it('leaves its bytes its own when the process stops after the write', async () => {
    await landBodyEdit(index.db, 'n1', B, {
      notePath: 'a.md',
      feed: async () => true,
      write: async () => {
        disk = B
        throw new Error('crash after the file write')
      }
    }).catch(() => {})
    expect(cached().contentHash).toBe(generateContentHash(A))
    expect(isOutsideEdit(index.db, 'n1', cached(), disk)).toBe(false)
  })
})

describe('a writer that does not feed the doc', () => {
  let index: TestDatabaseResult
  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
  })
  afterEach(() => index.close())

  it('moves the baseline for a frontmatter edit of the baseline', () => {
    const edited = `---\ntags: [x]\n---\n${A}`
    expect(baselineAfterWrite(index.db, 'n1', A, edited)).toBe(generateContentHash(edited))
  })

  it('keeps the baseline under a frontmatter edit of an outside edit', () => {
    const edited = `---\ntags: [x]\n---\n${B}`
    expect(baselineAfterWrite(index.db, 'n1', B, edited)).toBe(generateContentHash(A))
  })
})

/** A store that holds none of the doc until the test answers its waiters. */
function storeLackingTheDoc(): DocStore & { answer: (index: number) => void } {
  const waiters: Array<() => void> = []
  return {
    holdsDoc: () => false,
    whenPersisted: () => Promise.resolve(),
    whenStored: () => new Promise<void>((resolve) => waiters.push(resolve)),
    answer: (index) => waiters[index]()
  }
}

function typed(doc: Y.Doc, text: string): void {
  doc.getText('t').insert(doc.getText('t').length, text)
}

/** `doc`, serialized as it is now. */
const serialized = (doc: Y.Doc) => ({ doc, state: Y.snapshot(doc) })

describe('the unstored mark of a write the store lacks (#5698)', () => {
  let index: TestDatabaseResult
  beforeEach(() => {
    index = createTestIndexDb()
    insertNoteCache(index.db, { ...row, contentHash: generateContentHash(A) })
  })
  afterEach(() => index.close())
  const pending = () => getNoteCacheById(index.db, 'n1')!.pendingWriteHash

  // VERIFY-5703R5 (3)
  it("keeps a later write's mark when an earlier write's store lands", async () => {
    const store = storeLackingTheDoc()
    const doc = new Y.Doc()
    typed(doc, 'A')
    recordDocFile(index.db, 'n1', A, serialized(doc), store)
    typed(doc, 'B')
    recordDocFile(index.db, 'n1', B, serialized(doc), store)
    const markOfB = pending()

    store.answer(0)
    await new Promise((resolve) => setImmediate(resolve))

    expect(pending()).toBe(markOfB)
    expect(markOfB).toMatch(/^unstored-file:/)
  })

  it('gives a write that failed before it wrote the pending hash it found back', async () => {
    const doc = new Y.Doc()
    typed(doc, 'B')
    const write = writeDocWithBaseline(
      index.db,
      'n1',
      B,
      {
        write: () => Promise.reject(new Error('disk full')),
        read: async () => A
      },
      serialized(doc),
      storeLackingTheDoc()
    )

    await expect(write).rejects.toThrow('disk full')
    expect(pending()).toBeNull()
  })

  it('keeps the mark of a write that failed after it wrote', async () => {
    const doc = new Y.Doc()
    typed(doc, 'B')
    const write = writeDocWithBaseline(
      index.db,
      'n1',
      B,
      {
        write: () => Promise.reject(new Error('rename failed')),
        read: async () => B
      },
      serialized(doc),
      storeLackingTheDoc()
    )

    await expect(write).rejects.toThrow('rename failed')
    expect(pending()).toMatch(/^unstored-file:/)
  })

  it('takes in a file whose write carried a delete the stored doc lacks', () => {
    const doc = new Y.Doc()
    typed(doc, 'AB')
    const stored = new Y.Doc()
    Y.applyUpdate(stored, Y.encodeStateAsUpdate(doc))
    doc.getText('t').delete(1, 1)
    recordDocFile(index.db, 'n1', B, serialized(doc), storeLackingTheDoc())
    const cached = () => getNoteCacheById(index.db, 'n1')!

    expect(takesUnstoredFile(index.db, 'n1', cached(), B, stored)).toBe(true)
    expect(takesUnstoredFile(index.db, 'n1', cached(), B, doc)).toBe(false)
    expect(cached().pendingWriteHash).toBeNull()
  })

  it("reads a file holding a marked write's bytes as its own, keeping the mark", () => {
    const doc = new Y.Doc()
    typed(doc, 'B')
    const mark = markDocWrite(index.db, 'n1', B, serialized(doc), storeLackingTheDoc())
    const cached = () => getNoteCacheById(index.db, 'n1')!

    expect(isOutsideEdit(index.db, 'n1', cached(), B)).toBe(false)
    expect(cached()).toMatchObject({ contentHash: generateContentHash(B), pendingWriteHash: mark })
  })

  // VERIFY-5703R6 (2): a keystroke after the conversion is not in the file.
  it('records the state the file was serialized from, not a later one', () => {
    const doc = new Y.Doc()
    typed(doc, 'B')
    const written = serialized(doc)
    const stored = new Y.Doc()
    Y.applyUpdate(stored, Y.encodeStateAsUpdate(doc))
    typed(doc, 'C')
    recordDocFile(index.db, 'n1', B, written, storeLackingTheDoc())
    const cached = () => getNoteCacheById(index.db, 'n1')!

    expect(takesUnstoredFile(index.db, 'n1', cached(), B, stored)).toBe(false)
    expect(cached()).toMatchObject({ contentHash: generateContentHash(B), pendingWriteHash: null })
  })
})
