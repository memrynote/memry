import { describe, expect, it } from 'vitest'
import { FRAME_PADDING } from './canvas-draw-plan'
import {
  CLUSTER_CARD_GAP,
  CLUSTER_FRAME_GAP,
  CLUSTER_FRAMES_PER_ROW,
  planClusterLayout
} from './canvas-cluster-layout'
import type { SceneEditElement } from './canvas-scene-edit'

const card = (id: string, x: number, y: number, width = 200, height = 100): SceneEditElement => ({
  id,
  type: 'rectangle',
  x,
  y,
  width,
  height,
  angle: 0,
  customData: { entityType: 'note', entityId: id }
})

describe('planClusterLayout', () => {
  it('lays each group out in a grid inside its own frame, starting at the cards', () => {
    const scene = [card('a', 100, 50), card('b', 900, 400), card('c', 500, 300)]
    const layout = planClusterLayout(scene, [
      { name: 'Sleep', elementIds: ['a', 'b', 'c'] },
      { name: 'Empty', elementIds: [] }
    ])

    // 3 cards → 2 columns, 2 rows.
    expect(layout.frames).toEqual([
      {
        type: 'frame',
        x: 100,
        y: 50,
        width: 2 * 200 + CLUSTER_CARD_GAP + 2 * FRAME_PADDING,
        height: 2 * 100 + CLUSTER_CARD_GAP + 2 * FRAME_PADDING,
        name: 'Sleep',
        children: ['a', 'b', 'c']
      }
    ])
    expect(layout.moves).toEqual([
      { elementId: 'a', x: 100 + FRAME_PADDING, y: 50 + FRAME_PADDING },
      { elementId: 'b', x: 100 + FRAME_PADDING + 200 + CLUSTER_CARD_GAP, y: 50 + FRAME_PADDING },
      { elementId: 'c', x: 100 + FRAME_PADDING, y: 50 + FRAME_PADDING + 100 + CLUSTER_CARD_GAP }
    ])
  })

  it('starts to the right of anything that stays on the board', () => {
    const drawing = { ...card('shape', 0, 0, 1000, 500), customData: null }
    const caption = { ...card('caption', 10, 10, 50, 20), type: 'text', containerId: 'a' }
    const scene = [drawing, card('a', 100, 50), caption, card('b', 300, 80)]

    const layout = planClusterLayout(scene, [{ name: 'G', elementIds: ['a', 'b'] }])

    // The caption rides with its card, so only the drawing counts.
    expect(layout.frames[0]).toMatchObject({ x: 1000 + CLUSTER_FRAME_GAP, y: 50 })
  })

  it('wraps frames into rows', () => {
    const scene = Array.from({ length: CLUSTER_FRAMES_PER_ROW + 1 }, (_, i) => card(`n${i}`, 0, 0))
    const layout = planClusterLayout(
      scene,
      scene.map((el) => ({ name: el.id, elementIds: [el.id] }))
    )
    const frameHeight = 100 + 2 * FRAME_PADDING
    expect(layout.frames[CLUSTER_FRAMES_PER_ROW]).toMatchObject({
      x: 0,
      y: frameHeight + CLUSTER_FRAME_GAP
    })
  })

  it('ignores deleted and unknown elements', () => {
    const scene = [{ ...card('gone', 0, 0), isDeleted: true }, card('a', 0, 0)]
    const layout = planClusterLayout(scene, [
      { name: 'G', elementIds: ['gone', 'missing', 'a', 'a'] }
    ])
    expect(layout.frames[0].children).toEqual(['a'])
    expect(layout.moves).toHaveLength(1)
  })
})
