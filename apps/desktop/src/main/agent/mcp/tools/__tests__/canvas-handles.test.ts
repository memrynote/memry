import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import * as schema from '@memry/db-schema/data-schema'

const mocks = vi.hoisted(() => ({
  getCanvasContext: vi.fn(),
  getCanvas: vi.fn(),
  listCanvases: vi.fn(),
  listCanvasesWithCounts: vi.fn(),
  getNoteById: vi.fn(),
  getTaskById: vi.fn(),
  getCalendarEventById: vi.fn(),
  assertSpatialCanvasEnabled: vi.fn(),
  invokeCanvasWrite: vi.fn()
}))

vi.mock('../../../../canvas/vault-key', () => ({ getCanvasContext: mocks.getCanvasContext }))
vi.mock('../../../../canvas/store', () => ({
  getCanvas: mocks.getCanvas,
  listCanvases: mocks.listCanvases,
  listCanvasesWithCounts: mocks.listCanvasesWithCounts
}))
vi.mock('../../../../vault/notes', () => ({ getNoteById: mocks.getNoteById }))
vi.mock('../../../../database/queries/tasks', () => ({ getTaskById: mocks.getTaskById }))
vi.mock('../../../../calendar/repositories/calendar-events-repository', () => ({
  getCalendarEventById: mocks.getCalendarEventById
}))
vi.mock('../canvas-flag', () => ({
  assertSpatialCanvasEnabled: mocks.assertSpatialCanvasEnabled,
  isCanvasOperation: (op: string) => op.startsWith('canvas.')
}))
vi.mock('../canvas-write', () => ({ invokeCanvasWrite: mocks.invokeCanvasWrite }))

// summarizeScene is pure — exercised for real so the wiring is proven end to end.
import { createCanvasHandles } from '../canvas-handles'

const dataDb = {} as never

/**
 * A real data DB for the one block below that drives the real canvas store —
 * the canvas migrations only, which is all the store touches.
 */
function freshDataDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const file of [
    '0035_spatial_canvas.sql',
    '0036_canvas_assets.sql',
    '0045_canvas_files.sql',
    '0048_canvas_folders.sql'
  ]) {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'database', 'drizzle-data', file),
      'utf8'
    )
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
  return drizzle(sqlite, { schema })
}

function sceneWith(
  cards: { entityType: string; entityId: string }[],
  texts: string[] = []
): string {
  return JSON.stringify({
    type: 'excalidraw',
    elements: [
      ...cards.map((c, i) => ({
        id: `rect-${i}`,
        type: 'rectangle',
        customData: c
      })),
      ...texts.map((t, i) => ({ id: `text-${i}`, type: 'text', text: t }))
    ]
  })
}

describe('canvas handles', () => {
  let handles: ReturnType<typeof createCanvasHandles>

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCanvasContext.mockReturnValue({
      db: {},
      vaultId: 'vault-1',
      vaultPath: '/vault'
    })
    mocks.listCanvases.mockReturnValue([])
    mocks.assertSpatialCanvasEnabled.mockImplementation(() => {})
    handles = createCanvasHandles(dataDb)
  })

  describe('list', () => {
    it('maps store rows to the agent shape', async () => {
      mocks.listCanvasesWithCounts.mockReturnValue([
        { id: 'c1', title: 'Roadmap', folder: null, createdAt: 1, updatedAt: 5, itemCount: 2 }
      ])

      await expect(handles.list()).resolves.toEqual([
        { id: 'c1', title: 'Roadmap', folder: null, path: 'Roadmap', updated_at: 5, item_count: 2 }
      ])
    })

    it('qualifies same-titled canvases by folder so the two are tellable apart', async () => {
      mocks.listCanvasesWithCounts.mockReturnValue([
        { id: 'c-work', title: 'Plan', folder: 'Work', createdAt: 1, updatedAt: 5, itemCount: 0 },
        {
          id: 'c-personal',
          title: 'Plan',
          folder: 'Personal',
          createdAt: 1,
          updatedAt: 6,
          itemCount: 0
        }
      ])

      const entries = await handles.list()

      expect(entries.map((entry) => entry.path)).toEqual(['Work/Plan', 'Personal/Plan'])
      expect(entries.map((entry) => entry.folder)).toEqual(['Work', 'Personal'])
    })

    it('refuses when the spatialCanvas flag is off', async () => {
      mocks.assertSpatialCanvasEnabled.mockImplementation(() => {
        throw new Error('Spatial Canvas is disabled')
      })

      await expect(handles.list()).rejects.toThrow(/disabled/i)
      expect(mocks.listCanvasesWithCounts).not.toHaveBeenCalled()
    })
  })

  describe('read', () => {
    it('returns null for a missing canvas', async () => {
      mocks.getCanvas.mockReturnValue(null)

      await expect(handles.read('nope')).resolves.toBeNull()
    })

    it('resolves entity titles per type and never returns the scene', async () => {
      mocks.getCanvas.mockReturnValue({
        id: 'c1',
        title: 'Roadmap',
        createdAt: 1,
        updatedAt: 5,
        scene: sceneWith(
          [
            { entityType: 'note', entityId: 'n1' },
            { entityType: 'task', entityId: 't1' },
            { entityType: 'calendar_event', entityId: 'e1' }
          ],
          ['Q3 planning']
        )
      })
      mocks.getNoteById.mockResolvedValue({ id: 'n1', title: 'Spec' })
      mocks.getTaskById.mockReturnValue({ id: 't1', title: 'Ship it' })
      mocks.getCalendarEventById.mockReturnValue({ id: 'e1', title: 'Standup' })

      const detail = await handles.read('c1')

      expect(detail).toMatchObject({
        id: 'c1',
        title: 'Roadmap',
        created_at: 1,
        updated_at: 5,
        texts: ['Q3 planning'],
        element_count: 4,
        texts_truncated: false
      })
      expect(detail?.items).toEqual([
        { entity_type: 'note', entity_id: 'n1', title: 'Spec', missing: false },
        { entity_type: 'task', entity_id: 't1', title: 'Ship it', missing: false },
        { entity_type: 'calendar_event', entity_id: 'e1', title: 'Standup', missing: false }
      ])
      expect(JSON.stringify(detail)).not.toContain('"scene"')
    })

    it('reports a dangling card as missing rather than dropping it', async () => {
      mocks.getCanvas.mockReturnValue({
        id: 'c1',
        title: null,
        createdAt: 1,
        updatedAt: 5,
        scene: sceneWith([{ entityType: 'note', entityId: 'gone' }])
      })
      mocks.getNoteById.mockResolvedValue(null)

      const detail = await handles.read('c1')

      expect(detail?.items).toEqual([
        { entity_type: 'note', entity_id: 'gone', title: null, missing: true }
      ])
    })

    it('survives an unparseable scene with an empty summary', async () => {
      mocks.getCanvas.mockReturnValue({
        id: 'c1',
        title: null,
        createdAt: 1,
        updatedAt: 5,
        scene: '{not json'
      })

      const detail = await handles.read('c1')

      expect(detail).toMatchObject({ items: [], texts: [], element_count: 0 })
    })
  })

  describe('addItems', () => {
    const okWrite = {
      applied: [{ entityType: 'note', entityId: 'n1' }],
      skipped: [{ ref: { entityType: 'task', entityId: 't1' }, reason: 'already-on-canvas' }],
      updatedAt: 7,
      tooLarge: true
    }

    it('validates every entity exists before minting anything', async () => {
      mocks.getNoteById.mockResolvedValue(null)

      await expect(
        handles.addItems(
          { canvasId: 'c1', items: [{ entityType: 'note', entityId: 'ghost' }] },
          '1'
        )
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect(mocks.invokeCanvasWrite).not.toHaveBeenCalled()
    })

    it('routes the write and maps the outcome to snake_case', async () => {
      mocks.getNoteById.mockResolvedValue({ id: 'n1', title: 'Spec' })
      mocks.invokeCanvasWrite.mockResolvedValue(okWrite)

      const outcome = await handles.addItems(
        { canvasId: 'c1', items: [{ entityType: 'note', entityId: 'n1' }] },
        '1'
      )

      expect(mocks.invokeCanvasWrite).toHaveBeenCalledWith('1', {
        canvasId: 'c1',
        op: 'add',
        items: [{ entityType: 'note', entityId: 'n1' }]
      })
      expect(outcome).toEqual({
        canvas_id: 'c1',
        applied: [{ entity_type: 'note', entity_id: 'n1' }],
        skipped: [{ entity_type: 'task', entity_id: 't1', reason: 'already-on-canvas' }],
        updated_at: 7,
        too_large: true
      })
    })
  })

  describe('removeItem', () => {
    it('sends a single-item remove and does not require the entity to exist', async () => {
      mocks.getNoteById.mockResolvedValue(null)
      mocks.invokeCanvasWrite.mockResolvedValue({
        applied: [{ entityType: 'note', entityId: 'gone' }],
        skipped: [],
        updatedAt: 9,
        tooLarge: false
      })

      const outcome = await handles.removeItem(
        { canvasId: 'c1', item: { entityType: 'note', entityId: 'gone' } },
        null
      )

      expect(mocks.invokeCanvasWrite).toHaveBeenCalledWith(null, {
        canvasId: 'c1',
        op: 'remove',
        items: [{ entityType: 'note', entityId: 'gone' }]
      })
      expect(outcome).toMatchObject({ canvas_id: 'c1', updated_at: 9, too_large: false })
    })

    it('refuses when the spatialCanvas flag is off', async () => {
      mocks.assertSpatialCanvasEnabled.mockImplementation(() => {
        throw new Error('Spatial Canvas is disabled')
      })

      await expect(
        handles.removeItem({ canvasId: 'c1', item: { entityType: 'note', entityId: 'n1' } }, null)
      ).rejects.toThrow(/disabled/i)
      expect(mocks.invokeCanvasWrite).not.toHaveBeenCalled()
    })
  })

  describe('canvas name resolution with folders', () => {
    const row = (id: string, title: string | null, folder: string | null) => ({
      id,
      title,
      folder,
      icon: null,
      createdAt: 1,
      updatedAt: 2
    })
    const duplicates = [row('c-work', 'Plan', 'Work'), row('c-personal', 'Plan', 'Personal')]

    beforeEach(() => {
      mocks.invokeCanvasWrite.mockResolvedValue({ updatedAt: 11, tooLarge: false })
    })

    const drawnCanvasId = (): unknown =>
      (mocks.invokeCanvasWrite.mock.calls[0][1] as { canvasId: string }).canvasId

    it('resolves a folder-qualified name', async () => {
      mocks.listCanvases.mockReturnValue(duplicates)

      await handles.draw({ canvasId: 'Work/Plan', elements: [] }, '1')

      expect(drawnCanvasId()).toBe('c-work')
    })

    it('refuses an ambiguous bare name and lists the candidates', async () => {
      mocks.listCanvases.mockReturnValue(duplicates)

      await expect(handles.draw({ canvasId: 'Plan', elements: [] }, '1')).rejects.toMatchObject({
        code: 'VALIDATION',
        details: {
          candidates: [
            { id: 'c-work', path: 'Work/Plan' },
            { id: 'c-personal', path: 'Personal/Plan' }
          ]
        }
      })
      expect(mocks.invokeCanvasWrite).not.toHaveBeenCalled()
    })

    it('still resolves an unambiguous bare name', async () => {
      mocks.listCanvases.mockReturnValue([row('c-work', 'Plan', 'Work')])

      await handles.draw({ canvasId: 'Plan', elements: [] }, '1')

      expect(drawnCanvasId()).toBe('c-work')
    })

    it('matches a qualified name whatever its case', async () => {
      mocks.listCanvases.mockReturnValue(duplicates)

      await handles.draw({ canvasId: 'work/plan', elements: [] }, '1')

      expect(drawnCanvasId()).toBe('c-work')
    })

    it('prefers an exact qualified match over the bare-title fallback', async () => {
      mocks.listCanvases.mockReturnValue([
        row('c-root', 'Plan', null),
        row('c-work', 'Plan', 'Work')
      ])

      await handles.draw({ canvasId: 'Plan', elements: [] }, '1')

      expect(drawnCanvasId()).toBe('c-root')
    })

    it('leaves a real id alone even when a canvas is titled like it', async () => {
      mocks.listCanvases.mockReturnValue([row('c-work', 'Plan', 'Work'), row('Plan', null, null)])

      await handles.draw({ canvasId: 'Plan', elements: [] }, '1')

      expect(drawnCanvasId()).toBe('Plan')
    })

    it('reads the canvas a folder-qualified name points at', async () => {
      mocks.listCanvases.mockReturnValue(duplicates)
      mocks.getCanvas.mockReturnValue({
        id: 'c-personal',
        title: 'Plan',
        createdAt: 1,
        updatedAt: 5,
        scene: sceneWith([])
      })

      await handles.read('Personal/Plan')

      expect(mocks.getCanvas).toHaveBeenCalledWith({}, '/vault', 'c-personal')
    })

    it('refuses an ambiguous name on an item write before anything is minted', async () => {
      mocks.listCanvases.mockReturnValue(duplicates)
      mocks.getNoteById.mockResolvedValue({ id: 'n1', title: 'Spec' })

      await expect(
        handles.addItems({ canvasId: 'Plan', items: [{ entityType: 'note', entityId: 'n1' }] }, '1')
      ).rejects.toMatchObject({ code: 'VALIDATION' })
      expect(mocks.invokeCanvasWrite).not.toHaveBeenCalled()
    })

    /**
     * The only block that runs against the REAL store, on a real vault folder.
     *
     * Resolution here is only as good as the rows the store writes: a hand-made
     * pair of rows would prove the matcher and nothing about whether the app can
     * ever produce two canvases an agent cannot tell apart. Moving a second
     * `Plan` into `Work` is exactly the sequence that used to mint that pair.
     */
    describe('against the real store', () => {
      let realDb: ReturnType<typeof freshDataDb>
      let vault: string

      beforeEach(() => {
        realDb = freshDataDb()
        vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-handles-'))
        mocks.getCanvasContext.mockReturnValue({ db: realDb, vaultId: 'vault-1', vaultPath: vault })
        mocks.invokeCanvasWrite.mockResolvedValue({ updatedAt: 11, tooLarge: false })
      })

      afterEach(() => {
        fs.rmSync(vault, { recursive: true, force: true })
      })

      it('tells two same-titled canvases apart after one moves in beside the other', async () => {
        const store = await vi.importActual<typeof import('../../../../canvas/store')>(
          '../../../../canvas/store'
        )
        mocks.listCanvases.mockImplementation((db: never, vaultId: string) =>
          store.listCanvases(db, vaultId)
        )
        const settled = store.createCanvas(realDb, vault, 'vault-1', {
          title: 'Plan',
          folder: 'Work'
        })
        const moving = store.createCanvas(realDb, vault, 'vault-1', { title: 'Plan' })

        store.updateCanvas(realDb, vault, moving.id, { folder: 'Work' })

        await handles.draw({ canvasId: 'Work/Plan', elements: [] }, '1')
        await handles.draw({ canvasId: 'Work/Plan 2', elements: [] }, '1')

        expect(
          mocks.invokeCanvasWrite.mock.calls.map(
            (call) => (call[1] as { canvasId: string }).canvasId
          )
        ).toEqual([settled.id, moving.id])
      })
    })
  })
})
