import Graph from 'graphology'
import { describe, expect, it } from 'vitest'
import {
  GRAPH_LINK_PROPERTY,
  addRelationTarget,
  hasTag,
  isEditableGraphNode,
  noteRelationUri,
  relationLinksOf,
  removeRelationTarget,
  restoreRelationTarget
} from './graph-edits'

const B = noteRelationUri('note-b')
const C = noteRelationUri('note-c')

describe('addRelationTarget', () => {
  it('creates the property on first use', () => {
    expect(addRelationTarget({ status: 'draft' }, GRAPH_LINK_PROPERTY, B)).toEqual({
      status: 'added',
      properties: { status: 'draft', related: [B] }
    })
  })

  it('treats an empty value as unset', () => {
    expect(addRelationTarget({ related: [] }, 'related', B)).toEqual({
      status: 'added',
      properties: { related: [B] }
    })
    expect(addRelationTarget({ related: null }, 'related', B)).toEqual({
      status: 'added',
      properties: { related: [B] }
    })
  })

  it('appends to an existing relation value', () => {
    expect(addRelationTarget({ related: [C] }, 'related', B)).toEqual({
      status: 'added',
      properties: { related: [C, B] }
    })
  })

  it('is a no-op when any relation property already holds the target', () => {
    expect(addRelationTarget({ source: [B] }, 'related', B)).toEqual({ status: 'already-linked' })
  })

  it('refuses to overwrite a non-relation value', () => {
    expect(addRelationTarget({ related: 'see chapter 3' }, 'related', B)).toEqual({
      status: 'property-conflict'
    })
  })
})

describe('removeRelationTarget / restoreRelationTarget', () => {
  it('removes the target from every relation property and restores it', () => {
    const before = { related: [B, C], source: [B], title2: 'x' }
    const { properties, removedFrom } = removeRelationTarget(before, B)
    expect(properties).toEqual({ related: [C], source: [], title2: 'x' })
    expect(removedFrom).toEqual(['related', 'source'])

    expect(restoreRelationTarget(properties, removedFrom, B)).toEqual({
      related: [C, B],
      source: [B],
      title2: 'x'
    })
  })

  it('leaves properties untouched when the target is absent', () => {
    const { properties, removedFrom } = removeRelationTarget({ related: [C] }, B)
    expect(properties).toEqual({ related: [C] })
    expect(removedFrom).toEqual([])
  })

  it('skips a property that changed to a non-relation value before undo', () => {
    expect(restoreRelationTarget({ related: 'text now' }, ['related'], B)).toEqual({
      related: 'text now'
    })
  })
})

function buildGraph(): Graph {
  const graph = new Graph({ multi: true, type: 'undirected' })
  graph.addNode('a', { nodeType: 'note', label: 'A', isUnresolved: false })
  graph.addNode('b', { nodeType: 'note', label: 'B', isUnresolved: false })
  graph.addNode('c', { nodeType: 'note', label: 'C', isUnresolved: false })
  graph.addNode('j', { nodeType: 'journal', label: 'J', isUnresolved: false })
  graph.addNode('ghost:X', { nodeType: 'note', label: 'X', isUnresolved: true })
  graph.addEdgeWithKey('a-b-relation', 'a', 'b', { edgeType: 'relation' })
  graph.addEdgeWithKey('c-a-relation', 'c', 'a', { edgeType: 'relation' })
  graph.addEdgeWithKey('a-c-wikilink', 'a', 'c', { edgeType: 'wikilink' })
  return graph
}

describe('graph helpers', () => {
  it('only treats resolved notes as editable', () => {
    const graph = buildGraph()
    expect(isEditableGraphNode(graph, 'a')).toBe(true)
    expect(isEditableGraphNode(graph, 'j')).toBe(false)
    expect(isEditableGraphNode(graph, 'ghost:X')).toBe(false)
    expect(isEditableGraphNode(graph, 'missing')).toBe(false)
  })

  it('lists relation edges in both directions and skips wiki links', () => {
    expect(relationLinksOf(buildGraph(), 'a')).toEqual([
      { sourceId: 'a', targetId: 'b', otherId: 'b', otherLabel: 'B' },
      { sourceId: 'c', targetId: 'a', otherId: 'c', otherLabel: 'C' }
    ])
  })

  it('compares tags case-insensitively', () => {
    expect(hasTag(['Work'], 'work')).toBe(true)
    expect(hasTag(['work'], 'home')).toBe(false)
  })
})
