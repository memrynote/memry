import { describe, expect, it } from 'vitest'
import {
  planCardPlacements,
  removeCardElements,
  sceneBoundsRect,
  type SceneEditElement
} from './canvas-scene-edit'

const rect = (
  id: string,
  entityId: string | null,
  extra: Partial<SceneEditElement> = {}
): SceneEditElement => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 260,
  height: 168,
  angle: 0,
  ...(entityId ? { customData: { entityType: 'note', entityId } } : {}),
  ...extra
})

describe('sceneBoundsRect', () => {
  it('is the origin for an empty scene', () => {
    expect(sceneBoundsRect([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it('spans the live elements', () => {
    const bounds = sceneBoundsRect([
      rect('a', 'n1', { x: 10, y: 20 }),
      rect('b', 'n2', { x: 500, y: 300 })
    ])

    expect(bounds.minX).toBe(10)
    expect(bounds.minY).toBe(20)
    expect(bounds.maxX).toBe(760)
    expect(bounds.maxY).toBe(468)
  })

  it('ignores deleted elements', () => {
    const bounds = sceneBoundsRect([
      rect('a', 'n1', { x: 0, y: 0 }),
      rect('b', 'n2', { x: 9000, y: 9000, isDeleted: true })
    ])

    expect(bounds.maxX).toBe(260)
  })
})

describe('planCardPlacements', () => {
  it('places a card without overlapping an existing one', () => {
    const existing = [rect('a', 'n1', { x: 0, y: 0 })]

    const [skeleton] = planCardPlacements(existing, [
      { entityType: 'note', entityId: 'n2', width: 260, height: 168 }
    ])

    const overlaps =
      skeleton.x < 260 &&
      0 < skeleton.x + skeleton.width &&
      skeleton.y < 168 &&
      0 < skeleton.y + skeleton.height
    expect(overlaps).toBe(false)
    expect(skeleton.customData).toEqual({ entityType: 'note', entityId: 'n2' })
  })

  it('does not stack two new cards on each other', () => {
    const [first, second] = planCardPlacements(
      [],
      [
        { entityType: 'note', entityId: 'n1', width: 260, height: 168 },
        { entityType: 'note', entityId: 'n2', width: 260, height: 168 }
      ]
    )

    expect({ x: first.x, y: first.y }).not.toEqual({ x: second.x, y: second.y })
  })

  it('falls back to the compact card size when none is given', () => {
    const [skeleton] = planCardPlacements([], [{ entityType: 'task', entityId: 't1' }])

    expect(skeleton.width).toBe(260)
    expect(skeleton.height).toBe(168)
  })
})

describe('removeCardElements', () => {
  it('removes every card rectangle for the entity', () => {
    const elements = [rect('a', 'n1'), rect('b', 'n1'), rect('c', 'n2')]

    const result = removeCardElements(elements, { entityType: 'note', entityId: 'n1' })

    expect([...result.removedIds].sort()).toEqual(['a', 'b'])
    expect(result.elements.map((e) => e.id)).toEqual(['c'])
  })

  it('clears arrow bindings pointing at a removed card', () => {
    const elements: SceneEditElement[] = [
      rect('a', 'n1'),
      {
        id: 'arrow1',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        angle: 0,
        startBinding: { elementId: 'a' },
        endBinding: { elementId: 'c' }
      },
      rect('c', 'n2')
    ]

    const result = removeCardElements(elements, { entityType: 'note', entityId: 'n1' })
    const arrow = result.elements.find((e) => e.id === 'arrow1')

    expect(arrow?.startBinding).toBeNull()
    expect(arrow?.endBinding).toEqual({ elementId: 'c' })
  })

  it('drops boundElements entries referencing a removed card', () => {
    const elements = [
      rect('a', 'n1'),
      rect('c', 'n2', {
        boundElements: [
          { id: 'a', type: 'arrow' },
          { id: 'keep', type: 'text' }
        ]
      })
    ]

    const result = removeCardElements(elements, { entityType: 'note', entityId: 'n1' })

    expect(result.elements[0].boundElements).toEqual([{ id: 'keep', type: 'text' }])
  })

  it('is a no-op when the entity is not on the canvas', () => {
    const elements = [rect('c', 'n2')]

    const result = removeCardElements(elements, { entityType: 'note', entityId: 'nope' })

    expect(result.removedIds).toEqual([])
    expect(result.elements).toHaveLength(1)
  })
})
