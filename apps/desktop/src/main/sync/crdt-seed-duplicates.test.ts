import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import * as Y from 'yjs'
import { LeveldbPersistence, PREFERRED_TRIM_SIZE } from 'y-leveldb'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'
import { readOnlyStore, type CrdtStoreReader } from './crdt-persistence'
import {
  classifyBody,
  removeSeedCopy,
  repairSeedDuplicates,
  scanSeedDuplicates,
  type scheduleSeedDuplicateRepair,
  type SeedRepairHost
} from './crdt-seed-duplicates'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../lib/logger', () => ({ createLogger: () => log }))

const BODY = '# Trip\n\nPack the passport.\n\nBook the flights before Friday.'

async function seeded(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return doc
}

/** #2536 shape: a device seeds its empty doc from the file, then merges the server body. */
async function seedOverServerBody(markdown: string, serverMarkdown = markdown): Promise<Y.Doc> {
  const server = await seeded(serverMarkdown)
  const device = await seeded(markdown)
  Y.applyUpdate(device, Y.encodeStateAsUpdate(server))
  return device
}

function memoryStore(docs: Map<string, Y.Doc | null>): CrdtStoreReader & { reads: number } {
  const store = {
    reads: 0,
    docNames: async () => [...docs.keys()],
    updates: async (name: string) => {
      store.reads++
      const doc = docs.get(name)
      return doc ? [Y.encodeStateAsUpdate(doc)] : []
    }
  }
  return store
}

function liveRoots(doc: Y.Doc): number {
  return doc.getXmlFragment(CRDT_FRAGMENT_NAME).length
}

function copiesOf(doc: Y.Doc, text: string): number {
  return doc.getXmlFragment(CRDT_FRAGMENT_NAME).toJSON().split(text).length - 1
}

/** The provider's doc ops over plain Y.Docs, with the marker in a map like the store's meta. */
function memoryHost(
  docs: Map<string, Y.Doc>
): SeedRepairHost & { marked: Set<string>; storeId: string | null } {
  const marked = new Set<string>()
  return {
    marked,
    storeId: 'store-a',
    whenPersisted: async () => {},
    readOnlyStore: () => memoryStore(docs),
    holdDoc: () => async () => {},
    open: async (noteId) => {
      const doc = docs.get(noteId)
      if (!doc) throw new Error(`no doc ${noteId}`)
      return doc
    },
    seedRepairDone: async (noteId) => marked.has(noteId),
    markSeedRepairDone: async (noteId) => {
      marked.add(noteId)
    }
  }
}

describe('classifyBody', () => {
  it('calls a seed of the same markdown over the server body exact', async () => {
    expect(classifyBody(await seedOverServerBody(BODY))).toBe('exact')
  })

  it('keeps a seed whose text only contains the server body as duplicated, not exact', async () => {
    const doc = await seedOverServerBody(`${BODY}\n\nAnd the hotel.`, BODY)
    expect(classifyBody(doc)).toBe('duplicated')
  })

  it('flags a body seeded from markdown over the server body', async () => {
    const doc = await seedOverServerBody(BODY)
    expect(
      doc
        .getXmlFragment(CRDT_FRAGMENT_NAME)
        .toJSON()
        .match(/Pack the passport/g)
    ).toHaveLength(2)
    expect(classifyBody(doc)).toBe('exact')
  })

  it('passes a body that repeats a paragraph on purpose', async () => {
    const doc = await seeded('Chorus line.\n\nVerse.\n\nChorus line.\n\nChorus line.')
    expect(classifyBody(doc)).toBe('clean')
  })

  it('passes a body another device received and then edited', async () => {
    const server = await seeded(BODY)
    const device = new Y.Doc()
    Y.applyUpdate(device, Y.encodeStateAsUpdate(server))
    const blockGroup = device.getXmlFragment(CRDT_FRAGMENT_NAME).get(0)
    if (!(blockGroup instanceof Y.XmlElement)) throw new Error('expected a block group')
    blockGroup.insert(0, [new Y.XmlElement('blockContainer')])
    device.getXmlFragment(CRDT_FRAGMENT_NAME).insert(0, [new Y.XmlElement('blockGroup')])
    expect(classifyBody(device)).toBe('clean')
  })

  it('counts concurrent first writes with different text as forked, not duplicated', async () => {
    const a = await seeded('Written on the laptop.')
    const b = await seeded('Written on the desktop.')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    expect(classifyBody(a)).toBe('forked')
  })

  it('passes an empty note', () => {
    expect(classifyBody(new Y.Doc())).toBe('clean')
  })
})

describe('scanSeedDuplicates', () => {
  it('reports duplicated note ids across notes, journals and empty docs', async () => {
    const docs = new Map<string, Y.Doc | null>([
      ['note-dup', await seedOverServerBody(BODY)],
      ['j2026-11-20', await seeded('## Morning\n\nCoffee and a walk.')],
      ['j2026-11-19', await seedOverServerBody('## Evening\n\nRead a chapter.')],
      ['note-empty', null],
      ['note-clean', await seeded(BODY)]
    ])
    const scan = await scanSeedDuplicates(memoryStore(docs))
    expect(scan).toEqual({
      scanned: 5,
      forked: 2,
      duplicated: ['note-dup', 'j2026-11-19'],
      exact: ['note-dup', 'j2026-11-19'],
      unreadable: 0
    })
  })

  it('reads each doc of a large vault once', async () => {
    const clean = Y.encodeStateAsUpdate(await seeded(BODY))
    const dup = Y.encodeStateAsUpdate(await seedOverServerBody(BODY))
    const ids = Array.from({ length: 5000 }, (_, i) => `note-${i}`)
    let reads = 0
    const scan = await scanSeedDuplicates({
      docNames: async () => ids,
      updates: async (name) => {
        reads++
        return [Number(name.slice(5)) % 1000 === 0 ? dup : clean]
      }
    })
    expect(reads).toBe(ids.length)
    expect(scan.scanned).toBe(ids.length)
    expect(scan.duplicated).toEqual(['note-0', 'note-1000', 'note-2000', 'note-3000', 'note-4000'])
  })
})

function firstText(type: unknown): Y.XmlText {
  if (type instanceof Y.XmlText) return type
  if (type instanceof Y.XmlElement) {
    for (const child of type.toArray()) {
      try {
        return firstText(child)
      } catch {
        continue
      }
    }
  }
  throw new Error('no text')
}

describe('removeSeedCopy', () => {
  it('keeps both copies while an edit to the second waits for an update it depends on', async () => {
    const doc = await seedOverServerBody('Pack.\n\nBook.')
    const phone = new Y.Doc()
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(doc))
    const edits: Uint8Array[] = []
    phone.on('update', (update: Uint8Array) => edits.push(update))
    const text = firstText(phone.getXmlFragment(CRDT_FRAGMENT_NAME).get(1))
    text.insert(0, 'IMPORTANT ')
    text.insert(10, 'now ')
    Y.applyUpdate(doc, edits[1])
    expect(classifyBody(doc)).toBe('exact')

    expect(removeSeedCopy(doc)).toBe(false)

    Y.applyUpdate(doc, edits[0])
    expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).toJSON()).toContain('IMPORTANT now ')
  })

  it('removes the second copy and leaves the markdown as it was', async () => {
    const doc = await seedOverServerBody(BODY)
    const before = await yDocToMarkdown(doc)

    expect(removeSeedCopy(doc)).toBe(true)

    expect(liveRoots(doc)).toBe(1)
    expect(copiesOf(doc, 'Pack the passport')).toBe(1)
    expect(classifyBody(doc)).toBe('clean')
    expect(await yDocToMarkdown(doc)).toBe(before)
  })

  it('reaches a fresh device as one copy', async () => {
    const doc = await seedOverServerBody(BODY)
    removeSeedCopy(doc)

    const fresh = new Y.Doc()
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc))

    expect(copiesOf(fresh, 'Pack the passport')).toBe(1)
    expect(await yDocToMarkdown(fresh)).toBe(await yDocToMarkdown(doc))
  })

  it('converges to one copy when two devices repair the same body concurrently', async () => {
    const laptop = await seedOverServerBody(BODY)
    const desktop = new Y.Doc()
    Y.applyUpdate(desktop, Y.encodeStateAsUpdate(laptop))

    expect(removeSeedCopy(laptop)).toBe(true)
    expect(removeSeedCopy(desktop)).toBe(true)
    Y.applyUpdate(laptop, Y.encodeStateAsUpdate(desktop))
    Y.applyUpdate(desktop, Y.encodeStateAsUpdate(laptop))

    for (const doc of [laptop, desktop]) {
      expect(liveRoots(doc)).toBe(1)
      expect(copiesOf(doc, 'Pack the passport')).toBe(1)
    }
    expect(await yDocToMarkdown(laptop)).toBe(await yDocToMarkdown(desktop))
  })

  it.each([
    ['one block differs', BODY.replace('Friday', 'Monday')],
    ['the seed has extra trailing text', `${BODY}\n\nAnd the hotel.`],
    ['the seed lost a block', '# Trip\n\nPack the passport.']
  ])('keeps both copies when %s', async (_case, seedMarkdown) => {
    const doc = await seedOverServerBody(seedMarkdown, BODY)
    const before = Y.encodeStateAsUpdate(doc)

    expect(removeSeedCopy(doc)).toBe(false)

    expect(liveRoots(doc)).toBe(2)
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('keeps a paragraph repeated inside one body', async () => {
    const doc = await seeded('Chorus line.\n\nChorus line.')
    expect(removeSeedCopy(doc)).toBe(false)
    expect(copiesOf(doc, 'Chorus line.')).toBe(2)
  })

  it('keeps a copy the user edited after the duplication', async () => {
    const doc = await seedOverServerBody(BODY)
    const second = doc.getXmlFragment(CRDT_FRAGMENT_NAME).get(1)
    if (!(second instanceof Y.XmlElement)) throw new Error('expected a block group')
    second.insert(0, [new Y.XmlElement('blockContainer')])

    expect(removeSeedCopy(doc)).toBe(false)
    expect(liveRoots(doc)).toBe(2)
  })
})

describe('repairSeedDuplicates', () => {
  it('removes exact copies once, keeps near-duplicates, and logs ids only at info', async () => {
    const docs = new Map<string, Y.Doc>([
      ['note-dup', await seedOverServerBody(BODY)],
      ['note-near', await seedOverServerBody(BODY.replace('Friday', 'Monday'), BODY)],
      ['note-clean', await seeded(BODY)]
    ])
    const host = memoryHost(docs)

    await repairSeedDuplicates(host)

    expect(copiesOf(docs.get('note-dup')!, 'Pack the passport')).toBe(1)
    expect(liveRoots(docs.get('note-near')!)).toBe(2)
    expect([...host.marked]).toEqual(['note-dup'])
    expect(log.info).toHaveBeenCalledWith(
      'Seed duplicate repair finished',
      expect.objectContaining({ removed: 1, noteIds: ['note-dup'] })
    )
    const shipped = JSON.stringify(log.warn.mock.calls)
    expect(shipped).toContain('"removed":1')
    expect(shipped).not.toMatch(/note-/)
  })

  it('never removes a copy from a note it repaired before', async () => {
    const doc = await seedOverServerBody(BODY)
    const host = memoryHost(new Map([['note-dup', doc]]))
    host.marked.add('note-dup')

    await repairSeedDuplicates(host)

    expect(liveRoots(doc)).toBe(2)
  })

  it('sets the marker only once the delete is in the store', async () => {
    const doc = await seedOverServerBody(BODY)
    let stored!: () => void
    const host = {
      ...memoryHost(new Map([['note-dup', doc]])),
      whenPersisted: () => new Promise<void>((resolve) => (stored = resolve))
    }

    const run = repairSeedDuplicates(host)
    await vi.waitFor(() => expect(liveRoots(doc)).toBe(1))
    expect(host.marked.size).toBe(0)
    stored()
    await run

    expect([...host.marked]).toEqual(['note-dup'])
  })

  it('rechecks the open doc and leaves it when it no longer matches', async () => {
    const stored = await seedOverServerBody(BODY)
    const live = new Y.Doc()
    Y.applyUpdate(live, Y.encodeStateAsUpdate(stored))
    const second = live.getXmlFragment(CRDT_FRAGMENT_NAME).get(1)
    if (!(second instanceof Y.XmlElement)) throw new Error('expected a block group')
    second.insert(0, [new Y.XmlElement('blockContainer')])
    const host = {
      ...memoryHost(new Map([['note-dup', stored]])),
      open: async () => live
    }

    await repairSeedDuplicates(host)

    expect(liveRoots(live)).toBe(2)
    expect(host.marked.size).toBe(0)
  })

  // A vault switch while a note opens: the open doc is the new vault's same-id note.
  it('changes nothing once the store is replaced during an open', async () => {
    const docs = new Map([
      ['note-a', await seedOverServerBody(BODY)],
      ['note-b', await seedOverServerBody(BODY)]
    ])
    const host = memoryHost(docs)
    const open = host.open
    const opened: string[] = []
    host.open = async (noteId, windowId, options) => {
      opened.push(noteId)
      host.storeId = 'store-b'
      return open(noteId, windowId, options)
    }

    await repairSeedDuplicates(host)

    expect(opened).toEqual(['note-a'])
    expect(liveRoots(docs.get('note-a')!)).toBe(2)
    expect(liveRoots(docs.get('note-b')!)).toBe(2)
    expect(host.marked.size).toBe(0)
  })

  it('sets no marker in a store that replaced the repaired one before the delete was stored', async () => {
    const host = memoryHost(new Map([['note-dup', await seedOverServerBody(BODY)]]))
    host.whenPersisted = async () => {
      host.storeId = 'store-b'
    }

    await repairSeedDuplicates(host)

    expect(host.marked.size).toBe(0)
  })
})

describe('scheduleSeedDuplicateRepair', () => {
  // A fresh module per test: the once-per-process flag is module state.
  let schedule: typeof scheduleSeedDuplicateRepair
  beforeEach(async () => {
    vi.resetModules()
    schedule = (await import('./crdt-seed-duplicates')).scheduleSeedDuplicateRepair
  })
  afterEach(() => vi.useRealTimers())

  it('reads nothing when the store changed before the timer fires', async () => {
    vi.useFakeTimers()
    const doc = await seedOverServerBody(BODY)
    const host = memoryHost(new Map([['note-dup', doc]]))
    const open = vi.spyOn(host, 'open')

    schedule(host, () => true)
    host.storeId = 'store-b'
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(open).not.toHaveBeenCalled()
    expect(liveRoots(doc)).toBe(2)

    schedule(host, () => true)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    await vi.waitFor(() => expect(liveRoots(doc)).toBe(1))
  })

  it('reads nothing when a note body became owed before the timer fires', async () => {
    vi.useFakeTimers()
    const doc = await seedOverServerBody(BODY)
    const host = memoryHost(new Map([['note-dup', doc]]))
    const open = vi.spyOn(host, 'open')
    let owed = false

    schedule(host, () => !owed)
    owed = true
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(open).not.toHaveBeenCalled()
    expect(liveRoots(doc)).toBe(2)

    owed = false
    schedule(host, () => !owed)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    await vi.waitFor(() => expect(liveRoots(doc)).toBe(1))
  })

  it('repairs ten minutes after the call, once per process', async () => {
    vi.useFakeTimers()
    const doc = await seedOverServerBody(BODY)
    const host = memoryHost(new Map([['note-dup', doc]]))
    const storeRead = vi.spyOn(host, 'readOnlyStore')

    schedule(host, () => true)
    schedule(host, () => true)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1)
    expect(storeRead).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(host.marked.has('note-dup')).toBe(true))

    expect(storeRead).toHaveBeenCalledTimes(1)
    expect(liveRoots(doc)).toBe(1)
  })
})

describe('readOnlyStore', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('scans a real store without compacting a long update log', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'seed-dup-'))
    const persistence = new LeveldbPersistence(dir)
    const author = new Y.Doc()
    const text = author.getXmlFragment(CRDT_FRAGMENT_NAME)
    const updates: Uint8Array[] = []
    author.on('update', (update: Uint8Array) => updates.push(update))
    for (let i = 0; i <= PREFERRED_TRIM_SIZE; i++)
      text.insert(text.length, [new Y.XmlText(`l${i}`)])
    for (const update of updates) await persistence.storeUpdate('note-long', update)
    await persistence.storeUpdate('note-dup', Y.encodeStateAsUpdate(await seedOverServerBody(BODY)))

    const store = readOnlyStore(persistence)
    if (!store) throw new Error('expected a LevelDB store')
    const scan = await scanSeedDuplicates(store)

    expect(scan.duplicated).toEqual(['note-dup'])
    expect(await store.updates('note-long')).toHaveLength(updates.length)
    await persistence.destroy()
  })
})
