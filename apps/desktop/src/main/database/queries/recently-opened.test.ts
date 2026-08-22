import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canvases } from '@memry/db-schema/schema/canvas'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { recentlyOpened } from '@memry/db-schema/schema/recently-opened'
import { RECENTLY_OPENED_LIMIT } from '@memry/contracts/recents-api'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestDatabases } from '@tests/utils/test-db'
import type { DataDb, IndexDb } from '../types'
import { listRecentlyOpened, recordRecentlyOpened } from './recently-opened'

function seedNote(db: TestDb, id: string, title: string): void {
  db.insert(noteCache)
    .values({
      id,
      path: `notes/${id}.md`,
      title,
      fileType: 'markdown',
      createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z'
    })
    .run()
}

function seedCanvas(
  db: TestDb,
  id: string,
  title: string,
  options: { icon?: string | null; filePath?: string | null; deletedAt?: number | null } = {}
): void {
  db.insert(canvases)
    .values({
      id,
      vaultId: 'vault-1',
      title,
      filePath: options.filePath === undefined ? `canvases/${title}.excalidraw` : options.filePath,
      folder: null,
      icon: options.icon ?? null,
      snapshotCiphertext: '',
      vectorClock: {},
      createdAt: 1,
      updatedAt: 1,
      deletedAt: options.deletedAt ?? null
    })
    .run()
}

describe('recently-opened queries', () => {
  let dbs: { data: TestDatabaseResult; index: TestDatabaseResult; closeAll: () => void }
  let data: DataDb
  let index: IndexDb

  beforeEach(() => {
    dbs = createTestDatabases()
    data = dbs.data.db as unknown as DataDb
    index = dbs.index.db as unknown as IndexDb
  })

  afterEach(() => {
    dbs.closeAll()
  })

  it('returns items newest first', () => {
    seedNote(dbs.index.db, 'n1', 'First')
    seedNote(dbs.index.db, 'n2', 'Second')
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'n1',
      itemType: 'note',
      openedAt: '2026-08-20T10:00:00.000Z'
    })
    recordRecentlyOpened(data, {
      id: 'r2',
      itemId: 'n2',
      itemType: 'note',
      openedAt: '2026-08-20T11:00:00.000Z'
    })

    expect(listRecentlyOpened(data, index, 10).map((i) => i.itemId)).toEqual(['n2', 'n1'])
  })

  it('keeps one row per note and bumps its timestamp', () => {
    seedNote(dbs.index.db, 'n1', 'First')
    seedNote(dbs.index.db, 'n2', 'Second')
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'n1',
      itemType: 'note',
      openedAt: '2026-08-20T10:00:00.000Z'
    })
    recordRecentlyOpened(data, {
      id: 'r2',
      itemId: 'n2',
      itemType: 'note',
      openedAt: '2026-08-20T11:00:00.000Z'
    })
    recordRecentlyOpened(data, {
      id: 'r3',
      itemId: 'n1',
      itemType: 'note',
      openedAt: '2026-08-20T12:00:00.000Z'
    })

    const items = listRecentlyOpened(data, index, 10)
    expect(items.map((i) => i.itemId)).toEqual(['n1', 'n2'])
    expect(items).toHaveLength(2)
  })

  it('resolves the current title, not one captured at open time', () => {
    seedNote(dbs.index.db, 'n1', 'Old title')
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'n1',
      itemType: 'note',
      openedAt: '2026-08-20T10:00:00.000Z'
    })
    dbs.index.sqlite.prepare("UPDATE note_cache SET title = 'New title' WHERE id = 'n1'").run()

    expect(listRecentlyOpened(data, index, 10)[0].title).toBe('New title')
  })

  it('drops rows whose note no longer exists', () => {
    seedNote(dbs.index.db, 'n1', 'Kept')
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'n1',
      itemType: 'note',
      openedAt: '2026-08-20T10:00:00.000Z'
    })
    recordRecentlyOpened(data, {
      id: 'r2',
      itemId: 'gone',
      itemType: 'note',
      openedAt: '2026-08-20T11:00:00.000Z'
    })

    expect(listRecentlyOpened(data, index, 10).map((i) => i.itemId)).toEqual(['n1'])
  })

  it('prunes past the retention limit, keeping the newest', () => {
    for (let i = 0; i < RECENTLY_OPENED_LIMIT + 5; i++) {
      const id = `n${i}`
      seedNote(dbs.index.db, id, `Note ${i}`)
      recordRecentlyOpened(data, {
        id: `r${i}`,
        itemId: id,
        itemType: 'note',
        // Ascending timestamps: the last one written is the newest.
        openedAt: `2026-08-20T10:00:00.${String(i).padStart(3, '0')}Z`
      })
    }

    const rows = data.select().from(recentlyOpened).all()
    expect(rows).toHaveLength(RECENTLY_OPENED_LIMIT)
    const newest = `n${RECENTLY_OPENED_LIMIT + 4}`
    expect(rows.some((r) => r.itemId === newest)).toBe(true)
    expect(rows.some((r) => r.itemId === 'n0')).toBe(false)
  })

  it('honours the caller limit without shrinking the stored trail', () => {
    for (let i = 0; i < 5; i++) {
      seedNote(dbs.index.db, `n${i}`, `Note ${i}`)
      recordRecentlyOpened(data, {
        id: `r${i}`,
        itemId: `n${i}`,
        itemType: 'note',
        openedAt: `2026-08-20T0${i}:00:00.000Z`
      })
    }

    expect(listRecentlyOpened(data, index, 2)).toHaveLength(2)
    expect(data.select().from(recentlyOpened).all()).toHaveLength(5)
  })

  // Canvases are opened from the same tab bar as notes, so a trail that only
  // resolves notes silently drops half of what the user actually looked at.
  it('lists canvases alongside notes, newest first', () => {
    seedNote(dbs.index.db, 'n1', 'A note')
    seedCanvas(data as unknown as TestDb, 'c1', 'A canvas')
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'n1',
      itemType: 'note',
      openedAt: '2026-08-20T10:00:00.000Z'
    })
    recordRecentlyOpened(data, {
      id: 'r2',
      itemId: 'c1',
      itemType: 'canvas',
      openedAt: '2026-08-20T11:00:00.000Z'
    })

    const items = listRecentlyOpened(data, index, 10)
    expect(items.map((i) => [i.itemType, i.itemId])).toEqual([
      ['canvas', 'c1'],
      ['note', 'n1']
    ])
    expect(items[0]).toMatchObject({
      title: 'A canvas',
      path: 'canvases/A canvas.excalidraw',
      fileType: 'canvas'
    })
  })

  // Notes resolve against the note cache; a canvas-only trail must not fall
  // through the "no notes to resolve" shortcut and return nothing.
  it('returns canvases when the trail holds no notes at all', () => {
    seedCanvas(data as unknown as TestDb, 'c1', 'Solo')
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'c1',
      itemType: 'canvas',
      openedAt: '2026-08-20T10:00:00.000Z'
    })

    expect(listRecentlyOpened(data, index, 10).map((i) => i.itemId)).toEqual(['c1'])
  })

  it('resolves the current canvas title and icon, not one captured at open time', () => {
    seedCanvas(data as unknown as TestDb, 'c1', 'Old name', { icon: 'icon:pen-tool' })
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'c1',
      itemType: 'canvas',
      openedAt: '2026-08-20T10:00:00.000Z'
    })
    dbs.data.sqlite.prepare("UPDATE canvases SET title = 'New name' WHERE id = 'c1'").run()

    const item = listRecentlyOpened(data, index, 10)[0]
    expect(item.title).toBe('New name')
    expect(item.emoji).toBe('icon:pen-tool')
  })

  it('drops trashed canvases and canvases that no longer exist', () => {
    seedCanvas(data as unknown as TestDb, 'c1', 'Kept')
    seedCanvas(data as unknown as TestDb, 'c2', 'Trashed', { deletedAt: 123 })
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'c1',
      itemType: 'canvas',
      openedAt: '2026-08-20T10:00:00.000Z'
    })
    recordRecentlyOpened(data, {
      id: 'r2',
      itemId: 'c2',
      itemType: 'canvas',
      openedAt: '2026-08-20T11:00:00.000Z'
    })
    recordRecentlyOpened(data, {
      id: 'r3',
      itemId: 'gone',
      itemType: 'canvas',
      openedAt: '2026-08-20T12:00:00.000Z'
    })

    expect(listRecentlyOpened(data, index, 10).map((i) => i.itemId)).toEqual(['c1'])
  })

  // A canvas and a note could in principle carry the same id; the unique index
  // is on (item_type, item_id), so both rows must survive and resolve apart.
  it('keeps a note and a canvas that share an id apart', () => {
    seedNote(dbs.index.db, 'x1', 'Note x')
    seedCanvas(data as unknown as TestDb, 'x1', 'Canvas x')
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'x1',
      itemType: 'note',
      openedAt: '2026-08-20T10:00:00.000Z'
    })
    recordRecentlyOpened(data, {
      id: 'r2',
      itemId: 'x1',
      itemType: 'canvas',
      openedAt: '2026-08-20T11:00:00.000Z'
    })

    expect(listRecentlyOpened(data, index, 10).map((i) => i.title)).toEqual(['Canvas x', 'Note x'])
  })

  // A canvas can be saved with no title at all; the row must still resolve so
  // the widget can label it, rather than silently vanishing from the trail.
  it('keeps an untitled canvas, leaving the label to the caller', () => {
    seedCanvas(data as unknown as TestDb, 'c1', '', { filePath: null })
    dbs.data.sqlite.prepare("UPDATE canvases SET title = NULL WHERE id = 'c1'").run()
    recordRecentlyOpened(data, {
      id: 'r1',
      itemId: 'c1',
      itemType: 'canvas',
      openedAt: '2026-08-20T10:00:00.000Z'
    })

    const items = listRecentlyOpened(data, index, 10)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ itemId: 'c1', title: '', path: 'canvases' })
  })
})
