/**
 * Naming a drawn box from an outline entry.
 *
 * Built through `buildMindMap` rather than from hand-written nodes, because the
 * claim under test is that the outline's block ids and the map's boxes line up
 * on a real map — a fixture that agreed with itself would prove nothing.
 */

import { describe, expect, it } from 'vitest'
import { buildMindMap } from './build-mind-map'
import { mindMapHrefForBlock } from './mind-map-focus'
import { mindMapHrefOf } from './mind-map-hover'
import type { MindMapBoxElement, MindMapSourceBlock } from './mind-map-types'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

const map = buildMindMap(
  [
    heading('b-alpha', 1, 'Alpha'),
    { id: 'b-item', type: 'bulletListItem', content: [{ type: 'text', text: 'a point' }] },
    { id: 'b-tail', type: 'paragraph', content: [{ type: 'text', text: 'a line' }] }
  ],
  { rootLabel: 'Test Note', noteId: 'note-1' }
)

describe('mindMapHrefForBlock', () => {
  it('answers with the href the box for that block actually carries', () => {
    const node = map.nodes.find((candidate) => candidate.blockId === 'b-alpha')!
    const element = map.elements.find(
      (candidate): candidate is MindMapBoxElement =>
        candidate.id === node.id && candidate.type === 'rectangle'
    )!

    // The same string the hit test hands back on a click, which is what makes
    // it a usable handle on the live scene after the library remints every id.
    expect(mindMapHrefForBlock(map, 'b-alpha')).toBe(mindMapHrefOf(element))
    expect(mindMapHrefForBlock(map, 'b-alpha')).toContain('note-1')
  })

  it('answers for any drawn block, not only headings', () => {
    expect(mindMapHrefForBlock(map, 'b-item')).not.toBeNull()
  })

  it('answers null for a block this map did not draw', () => {
    // What a heading folded behind a "+N more", or dropped at the node cap,
    // looks like from here — and the signal the caller falls back on.
    expect(mindMapHrefForBlock(map, 'b-missing')).toBeNull()
  })

  it('answers null for a note with no map to speak of', () => {
    const empty = buildMindMap([], { rootLabel: 'Empty', noteId: 'note-1' })
    expect(mindMapHrefForBlock(empty, 'b-alpha')).toBeNull()
  })

  it('never answers with the root, which stands for the title and no block', () => {
    const root = map.nodes.find((node) => node.kind === 'root')!
    expect(root.blockId).toBeNull()
    // A root href would send the camera to the middle of the map for a block
    // that is nowhere on it.
    expect(mindMapHrefForBlock(map, '')).toBeNull()
  })
})
