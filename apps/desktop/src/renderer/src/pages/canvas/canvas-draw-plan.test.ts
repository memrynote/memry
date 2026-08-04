import { describe, expect, it } from 'vitest'
import type { CanvasDrawElement } from '@memry/contracts/canvas-draw'

import {
  ARROW_BINDING_GAP,
  applyDrawPlan,
  applyElementEdits,
  edgePoint,
  planDraw
} from './canvas-draw-plan'
import type { SceneEditElement } from './canvas-scene-edit'

const OPTIONS = {
  fontFamily: { 'hand-drawn': 5, normal: 6, code: 8, lilita: 7 },
  adaptiveRadius: 3,
  newId: (() => {
    let n = 0
    return () => `gen-${++n}`
  })()
}

function options(): typeof OPTIONS {
  let n = 0
  return { ...OPTIONS, newId: () => `gen-${++n}` }
}

function element(patch: Partial<SceneEditElement> & { id: string }): SceneEditElement {
  return { type: 'rectangle', x: 0, y: 0, width: 100, height: 100, angle: 0, ...patch }
}

describe('planDraw', () => {
  it('mints an id per element and reports the ref→id map', () => {
    const plan = planDraw(
      [],
      [
        { type: 'rectangle', ref: 'box', x: 0, y: 0, width: 100, height: 50 },
        { type: 'ellipse', x: 200, y: 0 }
      ] satisfies CanvasDrawElement[],
      options()
    )

    expect(plan.skeletons.map((s) => s.id)).toEqual(['gen-1', 'gen-2'])
    expect(plan.refs).toEqual({ box: 'gen-1' })
  })

  it('maps named fonts and roundness to Excalidraw values', () => {
    const plan = planDraw(
      [],
      [{ type: 'text', x: 0, y: 0, text: 'hi', fontFamily: 'code', roundness: 'round' }],
      options()
    )

    expect(plan.skeletons[0]).toMatchObject({ fontFamily: 8, roundness: { type: 3 } })
  })

  it("'sharp' roundness clears it rather than leaving the default", () => {
    const plan = planDraw([], [{ type: 'rectangle', roundness: 'sharp' }], options())
    expect(plan.skeletons[0].roundness).toBeNull()
  })

  it('computes arrow geometry between two shapes in the same batch', () => {
    const plan = planDraw(
      [],
      [
        { type: 'rectangle', ref: 'a', x: 0, y: 0, width: 100, height: 100 },
        { type: 'rectangle', ref: 'b', x: 300, y: 0, width: 100, height: 100 },
        { type: 'arrow', start: { ref: 'a' }, end: { ref: 'b' } }
      ],
      options()
    )

    const arrow = plan.skeletons[2]
    // Leaves a's right edge (x=100) plus the binding gap, arrives at b's left
    // edge (x=300) minus the same gap, both at the shared centre line y=50.
    expect(arrow.x).toBe(100 + ARROW_BINDING_GAP)
    expect(arrow.y).toBe(50)
    expect(arrow.points).toEqual([
      [0, 0],
      [200 - 2 * ARROW_BINDING_GAP, 0]
    ])
    expect(plan.bindings).toEqual([{ arrowId: 'gen-3', startId: 'gen-1', endId: 'gen-2' }])
  })

  it('binds an arrow to an element already on the canvas', () => {
    const existing = [element({ id: 'card-1', x: 0, y: 0, width: 100, height: 100 })]
    const plan = planDraw(
      existing,
      [
        { type: 'rectangle', ref: 'note', x: 300, y: 0, width: 100, height: 100 },
        { type: 'arrow', start: { elementId: 'card-1' }, end: { ref: 'note' } }
      ],
      options()
    )

    expect(plan.bindings).toEqual([{ arrowId: 'gen-2', startId: 'card-1', endId: 'gen-1' }])
    expect(plan.missingIds).toEqual([])
  })

  it('reports endpoints that name nothing instead of silently dropping the arrow', () => {
    const plan = planDraw(
      [],
      [{ type: 'arrow', start: { elementId: 'nope' }, end: { ref: 'ghost' } }],
      options()
    )

    expect(plan.missingIds).toEqual(['nope', 'ghost'])
    // Still drawn, so the user sees something they can fix.
    expect(plan.skeletons).toHaveLength(1)
    expect(plan.bindings).toEqual([])
  })

  it('sizes a frame around its children when given no bounds', () => {
    const plan = planDraw(
      [element({ id: 'old', x: 0, y: 0, width: 100, height: 100 })],
      [
        { type: 'rectangle', ref: 'new', x: 200, y: 50, width: 100, height: 100 },
        { type: 'frame', children: ['new', 'old'], name: 'Chapter 1' }
      ],
      options()
    )

    expect(plan.skeletons[1]).toMatchObject({
      type: 'frame',
      x: -32,
      y: -32,
      width: 364,
      height: 214,
      name: 'Chapter 1',
      // Only the same-batch child: the skeleton API resolves ids against this
      // array alone, and the pre-existing one is wired by frameId instead.
      children: ['gen-1']
    })
    expect(plan.frames).toEqual([{ frameId: 'gen-2', childIds: ['gen-1', 'old'] }])
  })

  it('never lets an agent mint an entity card', () => {
    const plan = planDraw(
      [],
      [{ type: 'rectangle', x: 0, y: 0 } as CanvasDrawElement & { customData?: unknown }],
      options()
    )
    expect(plan.skeletons[0].customData).toBeUndefined()
  })
})

describe('edgePoint', () => {
  it('returns the centre when the target is the shape itself', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 }
    expect(edgePoint(rect, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 })
  })
})

describe('applyDrawPlan', () => {
  it('writes both halves of a binding', () => {
    const existing = [element({ id: 'card-1' })]
    const created = [element({ id: 'arrow-1', type: 'arrow' })]

    const next = applyDrawPlan(existing, created, {
      bindings: [{ arrowId: 'arrow-1', startId: 'card-1' }],
      frames: []
    })

    const arrow = next.find((el) => el.id === 'arrow-1')
    const card = next.find((el) => el.id === 'card-1')
    expect(arrow?.startBinding).toEqual({
      elementId: 'card-1',
      focus: 0,
      gap: ARROW_BINDING_GAP
    })
    // Without this half the arrow stays behind when the card is dragged.
    expect(card?.boundElements).toEqual([{ id: 'arrow-1', type: 'arrow' }])
  })

  it('keeps a target’s existing boundElements', () => {
    const existing = [element({ id: 'card-1', boundElements: [{ id: 'old', type: 'arrow' }] })]
    const next = applyDrawPlan(existing, [element({ id: 'a2', type: 'arrow' })], {
      bindings: [{ arrowId: 'a2', endId: 'card-1' }],
      frames: []
    })

    expect(next.find((el) => el.id === 'card-1')?.boundElements).toEqual([
      { id: 'old', type: 'arrow' },
      { id: 'a2', type: 'arrow' }
    ])
  })

  it('puts pre-existing elements into a new frame', () => {
    const next = applyDrawPlan([element({ id: 'old' })], [element({ id: 'f1', type: 'frame' })], {
      bindings: [],
      frames: [{ frameId: 'f1', childIds: ['old'] }]
    })

    expect(next.find((el) => el.id === 'old')?.frameId).toBe('f1')
  })
})

describe('applyElementEdits', () => {
  const editOptions = { fontFamily: OPTIONS.fontFamily, adaptiveRadius: 3 }

  it('patches only the fields given and bumps the version', () => {
    const elements = [element({ id: 'e1', x: 0, y: 0, version: 4, strokeColor: '#000000' })]
    const result = applyElementEdits(elements, [{ elementId: 'e1', x: 50 }], editOptions)

    expect(result.elements[0]).toMatchObject({ x: 50, y: 0, strokeColor: '#000000', version: 5 })
    expect(result.updatedIds).toEqual(['e1'])
  })

  it('deletes an element and clears the arrow bound to it', () => {
    const elements = [
      element({ id: 'shape', boundElements: [{ id: 'arrow', type: 'arrow' }] }),
      element({ id: 'arrow', type: 'arrow', startBinding: { elementId: 'shape' } })
    ]

    const result = applyElementEdits(elements, [{ elementId: 'shape', delete: true }], editOptions)

    expect(result.deletedIds).toEqual(['shape'])
    expect(result.elements.map((el) => el.id)).toEqual(['arrow'])
    expect(result.elements[0].startBinding).toBeNull()
  })

  it('deletes a shape’s caption along with the shape', () => {
    const elements = [
      element({ id: 'box' }),
      element({ id: 'cap', type: 'text', containerId: 'box', text: 'hi' })
    ]

    const result = applyElementEdits(elements, [{ elementId: 'box', delete: true }], editOptions)
    expect(result.elements).toEqual([])
  })

  it('retexts a shape through its caption element, not the shape', () => {
    const elements = [
      element({ id: 'box' }),
      element({ id: 'cap', type: 'text', containerId: 'box', text: 'old' })
    ]

    const result = applyElementEdits(elements, [{ elementId: 'box', text: 'new' }], editOptions)

    expect(result.elements.find((el) => el.id === 'cap')?.text).toBe('new')
    expect(result.elements.find((el) => el.id === 'box')?.text).toBeUndefined()
  })

  it('refuses to rewrite a card’s text — that text lives in the note', () => {
    const elements = [element({ id: 'card', customData: { entityType: 'note', entityId: 'n1' } })]
    const result = applyElementEdits(
      elements,
      [{ elementId: 'card', text: 'hijacked', x: 20 }],
      editOptions
    )

    expect(result.elements[0].text).toBeUndefined()
    // The move still applies: geometry is the canvas's to own.
    expect(result.elements[0].x).toBe(20)
  })

  it('reports ids that are not on the canvas', () => {
    const result = applyElementEdits([], [{ elementId: 'ghost', x: 1 }], editOptions)
    expect(result.missingIds).toEqual(['ghost'])
    expect(result.updatedIds).toEqual([])
  })
})
