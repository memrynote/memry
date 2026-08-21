/**
 * Where a node activation goes, and how a drawn box's deep link finds its node.
 * Both are pure, so every case here runs without a DOM.
 */

import { describe, expect, it, vi } from 'vitest'
import { buildMindMap } from './build-mind-map'
import { activateMindMapNode, nodeFromMindMapLink } from './mind-map-navigation'
import type { MindMapBoxElement, MindMapPositionedNode, MindMapSourceBlock } from './mind-map-types'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

/** Every action a node can ask for, so a test asserts what was NOT called too. */
function actions() {
  return {
    navigateToBlock: vi.fn<(blockId: string | null) => void>(),
    openNote: vi.fn<(wikiTarget: string) => void>(),
    openTask: vi.fn<(taskId: string) => void>()
  }
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
    const acted = actions()
    activateMindMapNode(node('Alpha'), acted)
    expect(acted.navigateToBlock).toHaveBeenCalledWith('b-alpha')
  })

  it('sends the root node to the top of the note', () => {
    const acted = actions()
    activateMindMapNode(node('Test Note'), acted)
    // Null, not a block id: the root stands for the title, which is not a block.
    expect(acted.navigateToBlock).toHaveBeenCalledWith(null)
  })

  it('sends every structural node kind to its own block, the way a heading goes', () => {
    // The dispatch switches against a `never`, so this is the assertion that a
    // kind added to the map was actually given a behaviour rather than a case
    // that silently does nothing.
    const structured = buildMindMap(
      [
        { id: 'b-bullet', type: 'bulletListItem', content: [{ type: 'text', text: 'Bullet' }] },
        { id: 'b-number', type: 'numberedListItem', content: [{ type: 'text', text: 'Numbered' }] },
        { id: 'b-check', type: 'checkListItem', content: [{ type: 'text', text: 'Check' }] },
        { id: 'b-toggle', type: 'toggleListItem', content: [{ type: 'text', text: 'Toggle' }] },
        { id: 'b-callout', type: 'callout', content: [{ type: 'text', text: 'Callout' }] }
      ],
      { rootLabel: 'Test Note', noteId: 'note-1' }
    )

    const landed = structured.nodes
      .filter((candidate) => candidate.kind !== 'root')
      .map((candidate) => {
        const acted = actions()
        activateMindMapNode(candidate, acted)
        return [candidate.kind, acted.navigateToBlock.mock.calls]
      })

    expect(landed).toEqual([
      ['bullet', [['b-bullet']]],
      ['numbered', [['b-number']]],
      ['check', [['b-check']]],
      ['toggle', [['b-toggle']]],
      ['callout', [['b-callout']]]
    ])
  })

  it('opens the task a task node stands for, rather than the block that mentions it', () => {
    const tasks = buildMindMap(
      [{ id: 'b-task', type: 'taskBlock', props: { taskId: 't-1', title: 'Task' } }],
      { rootLabel: 'Test Note', noteId: 'note-1' }
    )
    const acted = actions()

    activateMindMapNode(
      tasks.nodes.find((candidate) => candidate.kind === 'task')!,
      acted
    )

    expect(acted.openTask).toHaveBeenCalledWith('t-1')
    expect(acted.navigateToBlock).not.toHaveBeenCalled()
  })

  it('lands a task block written before task ids on its own block instead', () => {
    const tasks = buildMindMap(
      [{ id: 'b-task', type: 'taskBlock', props: { taskId: '', title: 'Task' } }],
      { rootLabel: 'Test Note', noteId: 'note-1' }
    )
    const acted = actions()

    activateMindMapNode(
      tasks.nodes.find((candidate) => candidate.kind === 'task')!,
      acted
    )

    // Doing nothing is not an option: a node that draws has to go somewhere.
    expect(acted.navigateToBlock).toHaveBeenCalledWith('b-task')
    expect(acted.openTask).not.toHaveBeenCalled()
  })

  it('opens the note a wiki-link node names, and scrolls nowhere', () => {
    const linked = buildMindMap(
      [
        {
          id: 'b-item',
          type: 'bulletListItem',
          content: [{ type: 'wikiLink', props: { target: 'Roadmap#Q3', alias: 'the plan' } }]
        }
      ],
      { rootLabel: 'Test Note', noteId: 'note-1' }
    )
    const acted = actions()

    activateMindMapNode(
      linked.nodes.find((candidate) => candidate.kind === 'wikiLink')!,
      acted
    )

    // The target as written, heading half and all: the note page's own
    // wiki-link handler is what reads it, exactly as it reads one in the body.
    expect(acted.openNote).toHaveBeenCalledWith('Roadmap#Q3')
    expect(acted.navigateToBlock).not.toHaveBeenCalled()
  })

  it('lands a drawn box and its tree twin on the very same call', () => {
    const beta = node('Beta')
    const box = map.elements
      .filter((element) => element.type === 'rectangle')
      .find((element) => element.id === beta.id)!

    const fromTree = actions()
    const fromDrawing = actions()
    activateMindMapNode(beta, fromTree)
    activateMindMapNode(nodeFromMindMapLink(box.link!, map.nodes, 'note-1')!, fromDrawing)

    // Two projections of one layout, one activation: the picture cannot grow a
    // navigation behaviour the tree does not have.
    expect(fromDrawing.navigateToBlock.mock.calls).toEqual(fromTree.navigateToBlock.mock.calls)
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

  it('resolves a wiki-link box through the node id its href was minted with', () => {
    const linked = buildMindMap(
      [
        {
          id: 'b-item',
          type: 'bulletListItem',
          content: [
            { type: 'text', text: 'Read ' },
            { type: 'wikiLink', props: { target: 'R' } }
          ]
        }
      ],
      { rootLabel: 'Test Note', noteId: 'note-1' }
    )
    const link = linked.nodes.find((candidate) => candidate.kind === 'wikiLink')!
    const box = linked.elements.find(
      (element): element is MindMapBoxElement =>
        element.type === 'rectangle' && element.id === link.id
    )!

    // Its sentence's box and its own carry different hrefs, so a click on the
    // link cannot resolve to the sentence that holds it.
    expect(nodeFromMindMapLink(box.link!, linked.nodes, 'note-1')).toBe(link)
    expect(nodeFromMindMapLink('memry://note/note-1#^b-item', linked.nodes, 'note-1')?.kind).toBe(
      'bullet'
    )
  })

  it('refuses a link into another note', () => {
    // Answering with this map's root would send the user somewhere they never
    // clicked — and no box in this map ever carries one: a wiki-link box points
    // at its own node here, and WHERE that node goes is `wikiTarget` on it.
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
