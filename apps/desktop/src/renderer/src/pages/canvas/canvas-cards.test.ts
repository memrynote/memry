import { describe, it, expect } from 'vitest'
import {
  getCardRef,
  getCardRefs,
  extractEntityRefs,
  overlayTransform,
  viewportSceneRect,
  computeVisibleCardIds,
  sameMembership,
  makeCardSkeleton,
  readCanvasDragItem,
  canvasDragPayload,
  CANVAS_ITEM_DRAG_MIME,
  type CardElement
} from './canvas-cards'

function rect(overrides: Partial<CardElement> = {}): CardElement {
  return {
    id: 'e1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    customData: { entityType: 'note', entityId: 'n1' },
    ...overrides
  }
}

describe('getCardRef', () => {
  it('resolves a rectangle with valid card customData', () => {
    expect(getCardRef(rect())).toMatchObject({
      elementId: 'e1',
      entityType: 'note',
      entityId: 'n1'
    })
  })

  it('rejects non-rectangles, deleted, and missing/invalid customData', () => {
    expect(getCardRef(rect({ type: 'freedraw' }))).toBeNull()
    expect(getCardRef(rect({ isDeleted: true }))).toBeNull()
    expect(getCardRef(rect({ customData: null }))).toBeNull()
    expect(getCardRef(rect({ customData: { entityType: 'note' } }))).toBeNull()
    expect(getCardRef(rect({ customData: { entityType: 'bogus', entityId: 'x' } }))).toBeNull()
    expect(getCardRef(rect({ customData: { entityType: 'note', entityId: '' } }))).toBeNull()
  })
})

describe('getCardRefs / extractEntityRefs', () => {
  it('collects only live cards and dedupes entity refs', () => {
    const elements: CardElement[] = [
      rect({ id: 'a', customData: { entityType: 'note', entityId: 'n1' } }),
      rect({ id: 'b', customData: { entityType: 'note', entityId: 'n1' } }), // dup entity
      rect({ id: 'c', customData: { entityType: 'task', entityId: 't1' } }),
      rect({ id: 'd', type: 'freedraw' }), // not a card
      rect({ id: 'e', isDeleted: true, customData: { entityType: 'note', entityId: 'n9' } })
    ]
    expect(getCardRefs(elements).map((c) => c.elementId)).toEqual(['a', 'b', 'c'])
    expect(extractEntityRefs(elements)).toEqual([
      { entityType: 'note', entityId: 'n1' },
      { entityType: 'task', entityId: 't1' }
    ])
  })
})

describe('overlayTransform', () => {
  it('matches Excalidraw scene→viewport mapping (translate by scroll*zoom, scale by zoom)', () => {
    expect(overlayTransform({ scrollX: 10, scrollY: -20, zoom: { value: 2 } })).toBe(
      'translate(20px, -40px) scale(2)'
    )
  })
})

describe('viewportSceneRect', () => {
  it('converts the pixel viewport into scene coordinates', () => {
    const r = viewportSceneRect(
      { scrollX: 100, scrollY: 50, zoom: { value: 2 } },
      { width: 800, height: 600 }
    )
    expect(r).toEqual({ minX: -100, minY: -50, maxX: 800 / 2 - 100, maxY: 600 / 2 - 50 })
  })
})

describe('computeVisibleCardIds (hysteresis)', () => {
  const cards = getCardRefs([
    rect({ id: 'in', x: 0, y: 0 }),
    rect({ id: 'edge', x: 1100, y: 0 }),
    rect({ id: 'far', x: 5000, y: 5000 })
  ])
  const viewport = { minX: 0, minY: 0, maxX: 800, maxY: 600 }

  it('includes cards within enterPadding when not previously visible', () => {
    const visible = computeVisibleCardIds(cards, viewport, {
      enterPadding: 200,
      exitPadding: 500,
      previousVisible: new Set()
    })
    expect(visible.has('in')).toBe(true)
    expect(visible.has('edge')).toBe(false) // left edge 1100 > 800 + 200 enter
    expect(visible.has('far')).toBe(false)
  })

  it('keeps a previously-visible edge card until it exits the wider exit band', () => {
    const visible = computeVisibleCardIds(cards, viewport, {
      enterPadding: 200,
      exitPadding: 500,
      previousVisible: new Set(['edge'])
    })
    expect(visible.has('edge')).toBe(true) // 1100 <= 800 + 500 exit
  })
})

describe('sameMembership', () => {
  it('compares set membership', () => {
    expect(sameMembership(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(sameMembership(new Set(['a']), new Set(['a', 'b']))).toBe(false)
    expect(sameMembership(new Set(['a']), new Set(['b']))).toBe(false)
  })
})

describe('makeCardSkeleton', () => {
  it('centers a clean rectangle on the drop point and carries customData', () => {
    const skeleton = makeCardSkeleton({
      entityType: 'note',
      entityId: 'n1',
      centerX: 100,
      centerY: 100
    })
    expect(skeleton.type).toBe('rectangle')
    expect(skeleton.roughness).toBe(0)
    expect(skeleton.customData).toEqual({ entityType: 'note', entityId: 'n1' })
    // centered: x = center - width/2
    expect(skeleton.x).toBe(100 - skeleton.width / 2)
    expect(skeleton.y).toBe(100 - skeleton.height / 2)
  })
})

describe('readCanvasDragItem / canvasDragPayload', () => {
  it('round-trips a valid payload', () => {
    const payload = canvasDragPayload('task', 't1')
    const getData = (type: string): string => (type === CANVAS_ITEM_DRAG_MIME ? payload : '')
    expect(readCanvasDragItem(getData)).toEqual({ entityType: 'task', entityId: 't1' })
  })

  it('returns null for missing MIME, bad JSON, or invalid content', () => {
    expect(readCanvasDragItem(() => '')).toBeNull()
    expect(readCanvasDragItem(() => 'not json')).toBeNull()
    expect(readCanvasDragItem(() => JSON.stringify({ entityType: 'x', entityId: 'y' }))).toBeNull()
    expect(readCanvasDragItem(() => JSON.stringify({ entityType: 'note' }))).toBeNull()
  })
})
