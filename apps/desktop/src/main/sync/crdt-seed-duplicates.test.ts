import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import * as Y from 'yjs'
import { LeveldbPersistence, PREFERRED_TRIM_SIZE } from 'y-leveldb'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { markdownToYFragment } from './blocknote-converter'
import { readOnlyStore, type CrdtStoreReader } from './crdt-persistence'
import { classifyBody, scanSeedDuplicates } from './crdt-seed-duplicates'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const BODY = '# Trip\n\nPack the passport.\n\nBook the flights before Friday.'

async function seeded(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
  return doc
}

/** #2536 shape: a device seeds its empty doc from the file, then merges the server body. */
async function seedOverServerBody(markdown: string): Promise<Y.Doc> {
  const server = await seeded(markdown)
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

describe('classifyBody', () => {
  it('flags a body seeded from markdown over the server body', async () => {
    const doc = await seedOverServerBody(BODY)
    expect(
      doc
        .getXmlFragment(CRDT_FRAGMENT_NAME)
        .toJSON()
        .match(/Pack the passport/g)
    ).toHaveLength(2)
    expect(classifyBody(doc)).toBe('duplicated')
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
