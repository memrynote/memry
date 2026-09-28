import { describe, expect, it, vi } from 'vitest'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import {
  dragRefsForRow,
  planBatchPlacement,
  startCanvasRowsDrag,
  refFromViewRow,
  refsFromViewRows,
  splitNewRefs
} from './canvas-bulk-add'
import {
  CANVAS_ITEM_DRAG_MIME,
  CARD_DEFAULT_HEIGHT,
  CARD_DEFAULT_WIDTH,
  entityKey,
  type CanvasCardRef
} from './canvas-cards'

function row(id: string, overrides: Partial<NoteWithProperties> = {}): NoteWithProperties {
  return {
    id,
    path: `notes/${id}.md`,
    title: id,
    emoji: null,
    folder: '/',
    tags: [],
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    wordCount: 0,
    properties: {},
    ...overrides
  }
}

const SIZE = { width: CARD_DEFAULT_WIDTH, height: CARD_DEFAULT_HEIGHT }
const VIEWPORT = { minX: 0, minY: 0, maxX: 2000, maxY: 1200 }

function card(x: number, y: number): CanvasCardRef {
  return {
    elementId: `c-${x}-${y}`,
    entityType: 'note',
    entityId: `n-${x}-${y}`,
    x,
    y,
    width: CARD_DEFAULT_WIDTH,
    height: CARD_DEFAULT_HEIGHT,
    angle: 0
  }
}

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }, size = SIZE): boolean {
  return Math.abs(a.x - b.x) < size.width && Math.abs(a.y - b.y) < size.height
}

describe('refFromViewRow', () => {
  it('maps notes, files and tasks, and drops inbox rows', () => {
    expect(refFromViewRow(row('n1'))).toEqual({ entityType: 'note', entityId: 'n1' })
    expect(refFromViewRow(row('n2', { kind: 'note', fileType: 'markdown' }))).toEqual({
      entityType: 'note',
      entityId: 'n2'
    })
    expect(refFromViewRow(row('f1', { fileType: 'pdf' }))).toEqual({
      entityType: 'file',
      entityId: 'f1'
    })
    expect(refFromViewRow(row('t1', { kind: 'task' }))).toEqual({
      entityType: 'task',
      entityId: 't1'
    })
    expect(refFromViewRow(row('i1', { kind: 'inbox' }))).toBeNull()
  })
})

describe('refsFromViewRows', () => {
  it('keeps row order and each entity once', () => {
    const refs = refsFromViewRows([
      row('a'),
      row('b', { kind: 'task' }),
      row('a'),
      row('i', { kind: 'inbox' })
    ])
    expect(refs).toEqual([
      { entityType: 'note', entityId: 'a' },
      { entityType: 'task', entityId: 'b' }
    ])
  })

  it('applies a saved view filter', () => {
    const rows = [
      row('a', { properties: { status: 'done' } }),
      row('b', { properties: { status: 'open' } })
    ]
    expect(refsFromViewRows(rows, 'status == "open"')).toEqual([
      { entityType: 'note', entityId: 'b' }
    ])
  })
})

describe('splitNewRefs', () => {
  it('skips entities already on the board and counts them', () => {
    const onCanvas = new Set([entityKey('note', 'a')])
    const { fresh, skipped } = splitNewRefs(
      [
        { entityType: 'note', entityId: 'a' },
        { entityType: 'note', entityId: 'b' },
        { entityType: 'task', entityId: 'a' }
      ],
      onCanvas
    )
    expect(fresh).toEqual([
      { entityType: 'note', entityId: 'b' },
      { entityType: 'task', entityId: 'a' }
    ])
    expect(skipped).toBe(1)
  })
})

describe('planBatchPlacement', () => {
  it('returns nothing for an empty batch', () => {
    expect(planBatchPlacement([], [], VIEWPORT)).toEqual([])
  })

  it('lays the batch out as a row-major grid centred on an empty viewport', () => {
    const centers = planBatchPlacement(Array(4).fill(SIZE), [], VIEWPORT)
    expect(centers).toHaveLength(4)
    // 2x2: first row shares y, first column shares x.
    expect(centers[0].y).toBe(centers[1].y)
    expect(centers[0].x).toBe(centers[2].x)
    expect(centers[1].x).toBeGreaterThan(centers[0].x)
    expect(centers[2].y).toBeGreaterThan(centers[0].y)
    const midX = (centers[0].x + centers[1].x) / 2
    const midY = (centers[0].y + centers[2].y) / 2
    expect(midX).toBe(1000)
    expect(midY).toBe(600)
  })

  it('never places two batch cards on top of each other', () => {
    const centers = planBatchPlacement(Array(30).fill(SIZE), [], VIEWPORT)
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        expect(overlaps(centers[i], centers[j])).toBe(false)
      }
    }
  })

  it('keeps clear of cards already on the board', () => {
    const existing = [card(1000 - CARD_DEFAULT_WIDTH / 2, 600 - CARD_DEFAULT_HEIGHT / 2)]
    const centers = planBatchPlacement(Array(9).fill(SIZE), existing, VIEWPORT)
    const existingCenter = { x: 1000, y: 600 }
    for (const center of centers) {
      expect(overlaps(center, existingCenter)).toBe(false)
    }
  })

  it('falls back below the board when nothing near the viewport is free', () => {
    // A wall of cards far wider than the free-spot search reaches.
    const wall: CanvasCardRef[] = []
    for (let x = -20000; x <= 20000; x += CARD_DEFAULT_WIDTH) {
      for (let y = -12000; y <= 12000; y += CARD_DEFAULT_HEIGHT) {
        wall.push(card(x, y))
      }
    }
    const bottom = Math.max(...wall.map((c) => c.y + c.height))
    const centers = planBatchPlacement(Array(4).fill(SIZE), wall, VIEWPORT)
    for (const center of centers) {
      expect(center.y - CARD_DEFAULT_HEIGHT / 2).toBeGreaterThan(bottom)
    }
  })
})

describe('dragRefsForRow', () => {
  const rows = [row('a'), row('b', { kind: 'task' }), row('c', { kind: 'inbox' }), row('d')]

  it('drags the whole selection when the dragged row is part of it', () => {
    expect(dragRefsForRow(rows, 'a', new Set(['a', 'b', 'c']))).toEqual([
      { entityType: 'note', entityId: 'a' },
      { entityType: 'task', entityId: 'b' }
    ])
  })

  it('drags only the row when it is outside the selection', () => {
    expect(dragRefsForRow(rows, 'd', new Set(['a', 'b']))).toEqual([
      { entityType: 'note', entityId: 'd' }
    ])
  })
})

describe('startCanvasRowsDrag', () => {
  function dragEvent(target: unknown = null) {
    const setData = vi.fn()
    const event = {
      target: target as EventTarget | null,
      dataTransfer: { setData, effectAllowed: 'uninitialized' as DataTransfer['effectAllowed'] },
      preventDefault: vi.fn()
    }
    return { event, setData }
  }

  it('writes the canvas payload as a copy drag', () => {
    const { event, setData } = dragEvent()
    const refs = [
      { entityType: 'note' as const, entityId: 'a' },
      { entityType: 'task' as const, entityId: 'b' }
    ]
    startCanvasRowsDrag(event, refs)
    expect(event.dataTransfer.effectAllowed).toBe('copy')
    expect(setData).toHaveBeenCalledWith(CANVAS_ITEM_DRAG_MIME, JSON.stringify(refs))
  })

  it('cancels a drag with nothing a canvas can hold', () => {
    const { event, setData } = dragEvent()
    startCanvasRowsDrag(event, [])
    expect(event.preventDefault).toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()
  })

  it('leaves a drag that starts inside an editable cell alone', () => {
    const input = document.createElement('input')
    const { event, setData } = dragEvent(input)
    startCanvasRowsDrag(event, [{ entityType: 'note', entityId: 'a' }])
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()
  })
})
