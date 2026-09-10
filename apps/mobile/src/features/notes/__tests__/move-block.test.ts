import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { seedKey } from '@/db/keys'
import { EditorDocManager, type DocHalves, type DocStore } from '@/editor/doc-manager'
import { moveBlockToNote } from '@/features/notes/move-block'
import { openTestVault, seedNote, type TestVault } from './vault-db-harness'

/**
 * The host half of a block move (#2100).
 *
 * The clone's fidelity is pinned in `editor/__tests__/clone-y-subtree.test.ts`
 * against a document BlockNote authored; what is at stake HERE is the decision
 * around it — which note is written, where in it, and the two refusals whose
 * failure destroys content rather than merely annoying someone.
 */

interface Rig {
  manager: EditorDocManager
  persisted: Record<string, Uint8Array[]>
}

function rig(
  seeds: Record<string, Uint8Array>,
  opts: { appendThrows?: boolean; whileOpening?: (docId: string) => void } = {}
): Rig {
  const persisted: Record<string, Uint8Array[]> = {}
  const none: DocHalves = { snapshot: null, updates: [], lastSeq: 0 }
  const store: DocStore = {
    loadServerHalf: async (docId) => {
      // Fires INSIDE `openDoc`, which is the window a pull actually lands in.
      opts.whileOpening?.(docId)
      return seeds[docId] ? { ...none, snapshot: seeds[docId] } : none
    },
    loadLocalHalf: async () => none,
    loadServerUpdatesSince: async () => ({ snapshot: null, snapshotSeq: 0, updates: [] }),
    appendLocalUpdate: async (docId, update) => {
      if (opts.appendThrows) throw new Error('disk full')
      ;(persisted[docId] ??= []).push(update)
    }
  }
  return {
    manager: new EditorDocManager(store, { enqueueCrdtUpdate: async () => {} }),
    persisted
  }
}

/**
 * A note body in the shape the guest's y-prosemirror binding writes:
 * blockGroup > blockContainer > paragraph. An empty `text` is the blank
 * trailing line BlockNote keeps for the caret.
 */
function body(blocks: { id: string; text: string }[]): Uint8Array {
  const doc = new Y.Doc()
  const group = new Y.XmlElement('blockGroup')
  for (const block of blocks) {
    const container = new Y.XmlElement('blockContainer')
    container.setAttribute('id', block.id)
    const paragraph = new Y.XmlElement('paragraph')
    if (block.text.length > 0) {
      const text = new Y.XmlText()
      text.insert(0, block.text)
      paragraph.push([text])
    }
    container.push([paragraph])
    group.push([container])
  }
  doc.getXmlFragment('prosemirror').push([group])
  return Y.encodeStateAsUpdate(doc)
}

/** What a pull does when it removes a block from a note that is open. */
function removeFirstBlock(doc: Y.Doc): void {
  const group = doc.getXmlFragment('prosemirror').get(0)
  if (group instanceof Y.XmlElement) group.delete(0, 1)
}

/** The note as a reader sees it: one string per top-level block. */
function lines(doc: Y.Doc): string[] {
  const group = doc.getXmlFragment('prosemirror').get(0)
  if (!(group instanceof Y.XmlElement)) return []
  const out: string[] = []
  for (let i = 0; i < group.length; i++) {
    const container = group.get(i)
    if (!(container instanceof Y.XmlElement)) continue
    const content = container.get(0)
    let text = ''
    if (content instanceof Y.XmlElement) {
      for (let j = 0; j < content.length; j++) {
        const run = content.get(j)
        if (run instanceof Y.XmlText) text += run.toString()
      }
    }
    out.push(text)
  }
  return out
}

let vault: TestVault

beforeEach(() => {
  vault = openTestVault()
  seedNote(vault, { id: 'source', title: 'Source' })
  seedNote(vault, { id: 'target', title: 'Target' })
})

afterEach(() => vault.close())

describe('moveBlockToNote', () => {
  it('appends the block at the end of a note that has no blank last line', async () => {
    const { manager, persisted } = rig({
      source: body([
        { id: 'b1', text: 'stays' },
        { id: 'b2', text: 'moves' }
      ]),
      target: body([{ id: 't1', text: 'target body' }])
    })
    const sourceDoc = await manager.openDoc('source')

    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'b2', targetNoteId: 'target' }
    )

    expect(result).toEqual({ status: 'ok' })
    expect(lines((await manager.openDoc('target')).doc)).toEqual(['target body', 'moves'])
    expect(persisted.target).toHaveLength(1)
    // The source is the GUEST's to change: the delete is the second half of a
    // move whose first half cannot be rolled back.
    expect(lines(sourceDoc.doc)).toEqual(['stays', 'moves'])
  })

  it('inserts before the trailing blank line rather than under it', async () => {
    const { manager } = rig({
      source: body([{ id: 'b1', text: 'moves' }]),
      target: body([
        { id: 't1', text: 'target body' },
        { id: 't2', text: '' }
      ])
    })
    const sourceDoc = await manager.openDoc('source')

    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'b1', targetNoteId: 'target' }
    )

    expect(result).toEqual({ status: 'ok' })
    expect(lines((await manager.openDoc('target')).doc)).toEqual(['target body', 'moves', ''])
  })

  it('refuses a move into the note the block is already in', async () => {
    const { manager, persisted } = rig({ source: body([{ id: 'b1', text: 'moves' }]) })
    const sourceDoc = await manager.openDoc('source')

    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'b1', targetNoteId: 'source' }
    )

    expect(result.status).toBe('error')
    expect(persisted.source).toBeUndefined()
  })

  it('refuses a block the source note no longer holds', async () => {
    const { manager } = rig({
      source: body([{ id: 'b1', text: 'moves' }]),
      target: body([{ id: 't1', text: 'target body' }])
    })
    const sourceDoc = await manager.openDoc('source')

    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'gone', targetNoteId: 'target' }
    )

    expect(result).toEqual({
      status: 'error',
      detail: 'That block is no longer in this note'
    })
  })

  it('refuses a target whose real body has not been seeded into CRDT yet', async () => {
    // Exactly the shape the record applier leaves: markdown in `note_bodies`,
    // no CRDT at all. Writing a block in makes the doc non-empty, the seed is
    // skipped for ever, and the note's body is destroyed on every device.
    seedNote(vault, { id: 'unseeded', title: 'Recipes', markdown: '# Real body\n' })
    const { manager, persisted } = rig({ source: body([{ id: 'b1', text: 'moves' }]) })
    const sourceDoc = await manager.openDoc('source')

    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'b1', targetNoteId: 'unseeded' }
    )

    expect(result).toEqual({
      status: 'error',
      detail: 'Open "Recipes" once, then move the block'
    })
    expect(persisted.unseeded).toBeUndefined()
  })

  it('refuses an empty target that has no blockGroup to write into', async () => {
    const { manager } = rig({ source: body([{ id: 'b1', text: 'moves' }]) })
    const sourceDoc = await manager.openDoc('source')

    // No CRDT and no markdown: nothing to destroy, but also no blockGroup to
    // write into, so it still refuses — with the reason that is actually true.
    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'b1', targetNoteId: 'target' }
    )

    expect(result).toEqual({ status: 'error', detail: 'That note has no body yet' })
  })

  it('refuses when a pull removes the block while the target is opening', async () => {
    let sourceDoc: Awaited<ReturnType<EditorDocManager['openDoc']>> | null = null
    const { manager, persisted } = rig(
      {
        source: body([{ id: 'b1', text: 'moves' }]),
        target: body([{ id: 't1', text: 'target body' }])
      },
      {
        whileOpening: (docId) => {
          if (docId === 'target' && sourceDoc) removeFirstBlock(sourceDoc.doc)
        }
      }
    )
    sourceDoc = await manager.openDoc('source')

    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'b1', targetNoteId: 'target' }
    )

    // The alternative is an EMPTY blockContainer in the target — a block
    // BlockNote cannot render, on every device — with the guest going on to
    // delete the original.
    expect(result).toEqual({
      status: 'error',
      detail: 'That block is no longer in this note'
    })
    expect(persisted.target).toBeUndefined()
    expect(lines((await manager.openDoc('target')).doc)).toEqual(['target body'])
  })

  it('pins the target against eviction before it reads the seed guard', async () => {
    const { manager } = rig({ source: body([{ id: 'b1', text: 'moves' }]) })
    const sourceDoc = await manager.openDoc('source')
    const target = await manager.openDoc('target')

    // `inUse()` at the moment of every read the guard makes. An unpinned doc
    // is evictable, and `evictOldest` DESTROYS what it evicts.
    const pinned: boolean[] = []
    // Cast the way `vault-db-harness.ts` casts its own adapter: only the one
    // method the guard calls is real here.
    const db = {
      ...vault.db,
      getFirstAsync: (...args: Parameters<typeof vault.db.getFirstAsync>) => {
        pinned.push(target.inUse())
        return vault.db.getFirstAsync(...args)
      }
    } as unknown as typeof vault.db

    await moveBlockToNote(
      { docs: manager, db },
      { sourceDoc, blockId: 'b1', targetNoteId: 'target' }
    )

    expect(pinned.length).toBeGreaterThan(0)
    expect(pinned.every(Boolean)).toBe(true)
    // …and the pin is released, or the doc is never collectable again.
    expect(target.inUse()).toBe(false)
  })

  it('refuses a target whose seed markdown is still pending locally', async () => {
    // The other half of the guard: a note THIS device created, whose body is
    // in the `meta` marker rather than in `note_bodies`.
    seedNote(vault, { id: 'pending', title: 'Groceries', markdown: '' })
    await vault.db.runAsync('INSERT INTO meta (key, value) VALUES (?, ?)', [
      seedKey('pending'),
      '# Not yet in CRDT\n'
    ])
    const { manager, persisted } = rig({ source: body([{ id: 'b1', text: 'moves' }]) })
    const sourceDoc = await manager.openDoc('source')

    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'b1', targetNoteId: 'pending' }
    )

    expect(result).toEqual({
      status: 'error',
      detail: 'Open "Groceries" once, then move the block'
    })
    expect(persisted.pending).toBeUndefined()
  })

  it('reports an error and leaves the target untouched when the commit fails', async () => {
    const { manager } = rig(
      {
        source: body([{ id: 'b1', text: 'moves' }]),
        target: body([{ id: 't1', text: 'target body' }])
      },
      { appendThrows: true }
    )
    const sourceDoc = await manager.openDoc('source')

    const result = await moveBlockToNote(
      { docs: manager, db: vault.db },
      { sourceDoc, blockId: 'b1', targetNoteId: 'target' }
    )

    expect(result.status).toBe('error')
    // The doc must not have moved past a commit the device refused.
    expect(lines((await manager.openDoc('target')).doc)).toEqual(['target body'])
  })
})
