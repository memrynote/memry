/**
 * Where a node activation goes, and how a drawn box's deep link finds its node.
 * Both are pure, so every case here runs without a DOM.
 */

import { describe, expect, it, vi } from 'vitest'
import { buildMindMap } from './build-mind-map'
import { activateMindMapNode, nodeFromMindMapLink } from './mind-map-navigation'
import type { MindMapPositionedNode, MindMapSourceBlock } from './mind-map-types'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

const blocks = [heading('b-alpha', 1, 'Alpha'), heading('b-beta', 2, 'Beta')]
const map = buildMindMap(blocks, { rootLabel: 'Test Note', noteId: 'note-1' })

function node(label: string): MindMapPositionedNode {
  const found = map.nodes.find((candidate) => candidate.label === label)
  if (!found) throw new Error(`no node labelled ${label}`)
  return found
}

describe('activateMindMapNode', () => {
  it('sends a heading node to its own block', () => {
    const navigateToBlock = vi.fn()
    activateMindMapNode(node('Alpha'), { navigateToBlock })
    expect(navigateToBlock).toHaveBeenCalledWith('b-alpha')
  })

  it('sends the root node to the top of the note', () => {
    const navigateToBlock = vi.fn()
    activateMindMapNode(node('Test Note'), { navigateToBlock })
    // Null, not a block id: the root stands for the title, which is not a block.
    expect(navigateToBlock).toHaveBeenCalledWith(null)
  })

  it('lands a drawn box and its tree twin on the very same call', () => {
    const beta = node('Beta')
    const box = map.elements
      .filter((element) => element.type === 'rectangle')
      .find((element) => element.id === beta.id)!

    const fromTree = vi.fn()
    const fromDrawing = vi.fn()
    activateMindMapNode(beta, { navigateToBlock: fromTree })
    activateMindMapNode(nodeFromMindMapLink(box.link!, map.nodes, 'note-1')!, {
      navigateToBlock: fromDrawing
    })

    // Two projections of one layout, one activation: the picture cannot grow a
    // navigation behaviour the tree does not have.
    expect(fromDrawing.mock.calls).toEqual(fromTree.mock.calls)
  })
})

describe('nodeFromMindMapLink', () => {
  it('resolves a block anchor to the node that owns the block', () => {
    expect(nodeFromMindMapLink('memry://note/note-1#^b-beta', map.nodes, 'note-1')).toBe(
      node('Beta')
    )
  })

  it('resolves an unanchored link to the root', () => {
    expect(nodeFromMindMapLink('memry://note/note-1', map.nodes, 'note-1')).toBe(node('Test Note'))
  })

  it('resolves the link a box was actually minted with', () => {
    // The round trip that matters: what the pipeline drew is what a click on it
    // resolves back to.
    for (const element of map.elements) {
      if (element.type !== 'rectangle' || !element.link) continue
      expect(nodeFromMindMapLink(element.link, map.nodes, 'note-1')?.id).toBe(element.id)
    }
  })

  it('refuses a link into another note', () => {
    // Answering with this map's root would send the user somewhere they never
    // clicked. Opening the other note is a later ticket's job, not this one's.
    expect(nodeFromMindMapLink('memry://note/other#^b-beta', map.nodes, 'note-1')).toBeNull()
  })

  it('refuses a block anchor no node in this map owns', () => {
    expect(nodeFromMindMapLink('memry://note/note-1#^gone', map.nodes, 'note-1')).toBeNull()
  })

  it('refuses an anchor form that is not a block, and anything not a note', () => {
    // A heading-text anchor is what a SAVED canvas carries; in-session clicks
    // address the block directly, so one arriving here is not this map's node.
    expect(nodeFromMindMapLink('memry://note/note-1#Alpha', map.nodes, 'note-1')).toBeNull()
    expect(nodeFromMindMapLink('memry://task/t1', map.nodes, 'note-1')).toBeNull()
    expect(nodeFromMindMapLink('https://example.com', map.nodes, 'note-1')).toBeNull()
    expect(nodeFromMindMapLink('', map.nodes, 'note-1')).toBeNull()
  })
})
