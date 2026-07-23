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
  findFreeCardCenter,
  readCanvasDragItem,
  canvasDragPayload,
  CANVAS_ITEM_DRAG_MIME,
  CARD_DEFAULT_WIDTH,
  CARD_DEFAULT_HEIGHT,
  CARD_NOTE_MAX_WIDTH,
  CARD_NOTE_MAX_HEIGHT,
  cardDefaultSize,
  noteCardSize,
  type CardElement,
  type CanvasCardRef
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

  it('has a non-transparent fill so its whole interior is an arrow-binding target', () => {
    // Excalidraw only hit-tests a transparent shape on its outline, so a
    // transparent card would let arrows bind (and drags grab) only at its
    // border. A solid fill (hidden under the opaque overlay) makes the entire
    // card a binding/selection target — the enabler for M3 linking.
    const skeleton = makeCardSkeleton({
      entityType: 'note',
      entityId: 'n1',
      centerX: 0,
      centerY: 0
    })
    expect(skeleton.backgroundColor).not.toBe('transparent')
    expect(skeleton.fillStyle).toBe('solid')
  })

  it('sizes a task/event card at the compact default', () => {
    const task = makeCardSkeleton({ entityType: 'task', entityId: 't1', centerX: 0, centerY: 0 })
    const event = makeCardSkeleton({
      entityType: 'calendar_event',
      entityId: 'ev1',
      centerX: 0,
      centerY: 0
    })
    expect([task.width, task.height]).toEqual([CARD_DEFAULT_WIDTH, CARD_DEFAULT_HEIGHT])
    expect([event.width, event.height]).toEqual([CARD_DEFAULT_WIDTH, CARD_DEFAULT_HEIGHT])
  })

  it('falls back to the compact size for a note whose body is not known yet', () => {
    const note = makeCardSkeleton({ entityType: 'note', entityId: 'n1', centerX: 0, centerY: 0 })
    expect([note.width, note.height]).toEqual([CARD_DEFAULT_WIDTH, CARD_DEFAULT_HEIGHT])
  })

  it('still honours an explicit size (a resized card keeps its geometry)', () => {
    const skeleton = makeCardSkeleton({
      entityType: 'note',
      entityId: 'n1',
      centerX: 0,
      centerY: 0,
      width: 300,
      height: 200
    })
    expect([skeleton.width, skeleton.height]).toEqual([300, 200])
  })
})

describe('noteCardSize', () => {
  // Real markdown prose: a paragraph is ONE long source line, not hard-wrapped.
  const long = Array.from(
    { length: 200 },
    (_, i) => `Paragraph ${i}. ${'Some ordinary sentence about the note. '.repeat(5)}`
  )

  it('gives a three-letter note the compact card, not the full frame', () => {
    // The regression: "hey" opened at the maximum frame, mostly empty.
    expect(noteCardSize('hey')).toEqual({
      width: CARD_DEFAULT_WIDTH,
      height: CARD_DEFAULT_HEIGHT
    })
  })

  it('gives an empty note the compact card', () => {
    expect(noteCardSize('')).toEqual({ width: CARD_DEFAULT_WIDTH, height: CARD_DEFAULT_HEIGHT })
  })

  it('gives a long note the maximum frame, and clips the rest into scroll', () => {
    expect(noteCardSize(long.join('\n'))).toEqual({
      width: CARD_NOTE_MAX_WIDTH,
      height: CARD_NOTE_MAX_HEIGHT
    })
  })

  it('never leaves the compact..maximum band, whatever the body', () => {
    for (const body of ['', 'hey', 'x'.repeat(50_000), long.join('\n'), '\n'.repeat(400)]) {
      const { width, height } = noteCardSize(body)
      expect(width).toBeGreaterThanOrEqual(CARD_DEFAULT_WIDTH)
      expect(width).toBeLessThanOrEqual(CARD_NOTE_MAX_WIDTH)
      expect(height).toBeGreaterThanOrEqual(CARD_DEFAULT_HEIGHT)
      expect(height).toBeLessThanOrEqual(CARD_NOTE_MAX_HEIGHT)
    }
  })

  it('grows monotonically as the body grows', () => {
    // A note that gained a paragraph must never come back smaller.
    let previous = 0
    for (const rows of [1, 5, 12, 30, 80, 200]) {
      const { height } = noteCardSize(long.slice(0, rows).join('\n'))
      expect(height).toBeGreaterThanOrEqual(previous)
      previous = height
    }
  })

  it('widens for a single long line instead of wrapping it into a tall column', () => {
    const oneLongLine = noteCardSize('word '.repeat(60))
    expect(oneLongLine.width).toBeGreaterThan(CARD_DEFAULT_WIDTH)
    // ...and a body of the same length split into short lines stays narrow.
    const manyShortLines = noteCardSize(Array.from({ length: 60 }, () => 'word').join('\n'))
    expect(manyShortLines.width).toBe(CARD_DEFAULT_WIDTH)
    expect(manyShortLines.height).toBeGreaterThan(oneLongLine.height)
  })

  it('counts wrapped rows, so one very long line is taller than one short line', () => {
    const wrapped = noteCardSize('z'.repeat(4000))
    expect(wrapped.height).toBeGreaterThan(noteCardSize('z'.repeat(10)).height)
  })
})

describe('cardDefaultSize', () => {
  it('sizes a note from its body and everything else at the compact default', () => {
    expect(cardDefaultSize('note', 'hey')).toEqual(noteCardSize('hey'))
    expect(cardDefaultSize('task')).toEqual({
      width: CARD_DEFAULT_WIDTH,
      height: CARD_DEFAULT_HEIGHT
    })
    expect(cardDefaultSize('calendar_event')).toEqual({
      width: CARD_DEFAULT_WIDTH,
      height: CARD_DEFAULT_HEIGHT
    })
  })

  it('ignores a body passed for a non-note type', () => {
    expect(cardDefaultSize('task', 'x'.repeat(5000))).toEqual({
      width: CARD_DEFAULT_WIDTH,
      height: CARD_DEFAULT_HEIGHT
    })
  })
})

describe('findFreeCardCenter', () => {
  const viewport = { minX: 0, minY: 0, maxX: 1600, maxY: 1000 }
  const center = { x: 800, y: 500 }

  function cardAt(id: string, centerX: number, centerY: number): CanvasCardRef {
    return {
      elementId: id,
      entityType: 'note',
      entityId: id,
      x: centerX - CARD_DEFAULT_WIDTH / 2,
      y: centerY - CARD_DEFAULT_HEIGHT / 2,
      width: CARD_DEFAULT_WIDTH,
      height: CARD_DEFAULT_HEIGHT,
      angle: 0
    }
  }

  function overlaps(a: CanvasCardRef, b: CanvasCardRef): boolean {
    return (
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    )
  }

  it('uses the viewport centre when nothing is there', () => {
    expect(findFreeCardCenter([], viewport)).toEqual(center)
  })

  it('steps off a card already occupying the centre', () => {
    const placed = findFreeCardCenter([cardAt('a', center.x, center.y)], viewport)
    expect(placed).not.toEqual(center)
    expect(overlaps(cardAt('new', placed.x, placed.y), cardAt('a', center.x, center.y))).toBe(false)
  })

  it('never stacks across repeated placements (the #871 pile)', () => {
    // Each pick sees the cards the previous picks added — exactly how the
    // overlay re-reads the scene between picks.
    const cards: CanvasCardRef[] = []
    for (let i = 0; i < 9; i++) {
      const { x, y } = findFreeCardCenter(cards, viewport)
      cards.push(cardAt(`c${i}`, x, y))
    }
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        expect(overlaps(cards[i], cards[j])).toBe(false)
      }
    }
  })

  it('steps by the size it is given, so a note card clears a note-sized neighbour', () => {
    // The caller passes the note size; stepping by the compact size would drop
    // the next note card on top of the previous one.
    const noteSize = { width: CARD_NOTE_MAX_WIDTH, height: CARD_NOTE_MAX_HEIGHT }
    const occupant: CanvasCardRef = {
      elementId: 'a',
      entityType: 'note',
      entityId: 'a',
      x: center.x - CARD_NOTE_MAX_WIDTH / 2,
      y: center.y - CARD_NOTE_MAX_HEIGHT / 2,
      width: CARD_NOTE_MAX_WIDTH,
      height: CARD_NOTE_MAX_HEIGHT,
      angle: 0
    }
    const placed = findFreeCardCenter([occupant], viewport, noteSize)
    const candidate = {
      ...occupant,
      elementId: 'new',
      x: placed.x - CARD_NOTE_MAX_WIDTH / 2,
      y: placed.y - CARD_NOTE_MAX_HEIGHT / 2
    }
    expect(overlaps(candidate, occupant)).toBe(false)
  })

  it('places the first offset card beside the centre, not far from it', () => {
    const placed = findFreeCardCenter([cardAt('a', center.x, center.y)], viewport)
    expect(Math.abs(placed.x - center.x)).toBeLessThanOrEqual(CARD_DEFAULT_WIDTH * 2)
    expect(Math.abs(placed.y - center.y)).toBeLessThanOrEqual(CARD_DEFAULT_HEIGHT * 2)
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
