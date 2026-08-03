import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCanvasContext: vi.fn(),
  getCanvas: vi.fn(),
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
    mocks.getCanvasContext.mockResolvedValue({
      db: {},
      vaultId: 'vault-1',
      vaultKey: new Uint8Array()
    })
    mocks.assertSpatialCanvasEnabled.mockImplementation(() => {})
    handles = createCanvasHandles(dataDb)
  })

  describe('list', () => {
    it('maps store rows to the agent shape', async () => {
      mocks.listCanvasesWithCounts.mockReturnValue([
        { id: 'c1', title: 'Roadmap', createdAt: 1, updatedAt: 5, itemCount: 2 }
      ])

      await expect(handles.list()).resolves.toEqual([
        { id: 'c1', title: 'Roadmap', updated_at: 5, item_count: 2 }
      ])
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
})
