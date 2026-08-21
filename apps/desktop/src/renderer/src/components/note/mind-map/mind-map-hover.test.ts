/**
 * The hit test that replaced the drawing library's own.
 *
 * Pure arithmetic over plain data, which is the point: jsdom has no canvas, so
 * the only way to be sure a click lands on the box the user aimed at is to
 * check the geometry somewhere a canvas is not needed.
 *
 * The elements here are minted by the real pipeline wherever the case allows
 * it, so the `customData` this reads is the `customData` `mintElements` writes
 * — the one coupling between the two files that a rename could break silently.
 */

import { describe, expect, it } from 'vitest'
import { buildMindMap } from './build-mind-map'
import { hitMindMapBox, mindMapHoverAnchor, mindMapHrefOf } from './mind-map-hover'
import type { MindMapHitElement } from './mind-map-hover'

const BOX: MindMapHitElement = {
  x: 100,
  y: 50,
  width: 200,
  height: 40,
  customData: { memryHref: 'memry://note/n1#^b' }
}

describe('mindMapHrefOf', () => {
  it('reads the address a drawn box was minted with', () => {
    const map = buildMindMap(
      [{ id: 'b-h', type: 'heading', props: { level: 1 }, content: [{ type: 'text', text: 'A' }] }],
      { rootLabel: 'Note', noteId: 'n1' }
    )
    const boxes = map.elements.filter((element) => element.type === 'rectangle')

    // The round trip that a rename of the key would break, asserted across the
    // two files that share it rather than inside either one.
    expect(boxes.length).toBeGreaterThan(0)
    for (const box of boxes) expect(mindMapHrefOf(box)).toMatch(/^memry:\/\/note\/n1/)
  })

  it('answers for nothing else on the drawing', () => {
    expect(mindMapHrefOf({ x: 0, y: 0, width: 1, height: 1 })).toBeNull()
    expect(mindMapHrefOf({ x: 0, y: 0, width: 1, height: 1, customData: null })).toBeNull()
    expect(
      mindMapHrefOf({ x: 0, y: 0, width: 1, height: 1, customData: { entityType: 'note' } })
    ).toBeNull()
    expect(
      mindMapHrefOf({ x: 0, y: 0, width: 1, height: 1, customData: { memryHref: '' } })
    ).toBeNull()
  })
})

describe('hitMindMapBox', () => {
  it('answers for the whole bounding box, edges included', () => {
    // This is what view mode's own link hit test was doing for us, and it is
    // why a click anywhere on a node has always opened it.
    for (const [x, y] of [
      [100, 50],
      [300, 50],
      [100, 90],
      [300, 90],
      [200, 70]
    ]) {
      expect(hitMindMapBox([BOX], { x, y })?.href).toBe('memry://note/n1#^b')
    }
  })

  it('answers for nothing outside it', () => {
    expect(hitMindMapBox([BOX], { x: 99, y: 70 })).toBeNull()
    expect(hitMindMapBox([BOX], { x: 301, y: 70 })).toBeNull()
    expect(hitMindMapBox([BOX], { x: 200, y: 49 })).toBeNull()
    expect(hitMindMapBox([BOX], { x: 200, y: 91 })).toBeNull()
  })

  it('ignores an element with no address, however large', () => {
    const connector: MindMapHitElement = { x: 0, y: 0, width: 1000, height: 1000 }
    expect(hitMindMapBox([connector], { x: 200, y: 70 })).toBeNull()
    // And never answers with it in place of a real box underneath the pointer.
    expect(hitMindMapBox([connector, BOX], { x: 200, y: 70 })?.href).toBe('memry://note/n1#^b')
  })

  it('ignores a deleted element', () => {
    expect(hitMindMapBox([{ ...BOX, isDeleted: true }], { x: 200, y: 70 })).toBeNull()
  })

  it('answers with the box drawn last where two overlap', () => {
    const over: MindMapHitElement = { ...BOX, customData: { memryHref: 'memry://note/n1#^c' } }
    expect(hitMindMapBox([BOX, over], { x: 200, y: 70 })?.href).toBe('memry://note/n1#^c')
  })

  it('hands back the rectangle, so the affordance can be pinned to the box', () => {
    expect(hitMindMapBox([BOX], { x: 200, y: 70 })).toEqual({
      href: 'memry://note/n1#^b',
      x: 100,
      y: 50,
      width: 200,
      height: 40
    })
  })
})

describe('mindMapHoverAnchor', () => {
  const hit = { href: 'h', x: 100, y: 50, width: 200, height: 40 }

  it('sits under the box and centred on it', () => {
    // Centred rather than aligned to one end: the map mirrors in RTL, and a
    // tooltip anchored to a fixed side would then hang off the wrong end of
    // every node.
    expect(mindMapHoverAnchor(hit, { scrollX: 0, scrollY: 0, zoom: { value: 1 } })).toEqual({
      x: 200,
      y: 90
    })
  })

  it('follows the camera', () => {
    expect(mindMapHoverAnchor(hit, { scrollX: -100, scrollY: -50, zoom: { value: 1 } })).toEqual({
      x: 100,
      y: 40
    })
    expect(mindMapHoverAnchor(hit, { scrollX: 0, scrollY: 0, zoom: { value: 2 } })).toEqual({
      x: 400,
      y: 180
    })
  })

  it('survives a zoom of zero rather than placing the card at NaN', () => {
    expect(mindMapHoverAnchor(hit, { scrollX: 0, scrollY: 0, zoom: { value: 0 } })).toEqual({
      x: 200,
      y: 90
    })
  })
})
