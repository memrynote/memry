/**
 * Every projection and layout rule of the mind map, asserted through the single
 * public entry point and nothing else. No DOM is involved, which is what makes
 * this coverage cheap enough to be exhaustive.
 */

import { describe, expect, it } from 'vitest'
import { buildMindMap } from './build-mind-map'
import type { MindMapNode, MindMapSourceBlock } from './mind-map-types'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

function paragraph(id: string, text: string): MindMapSourceBlock {
  return { id, type: 'paragraph', content: [{ type: 'text', text }] }
}

/** Labels of a node's children, in order. */
function childLabels(node: MindMapNode): string[] {
  return node.children.map((child) => child.label)
}

function labelled(tree: MindMapNode, label: string): MindMapNode {
  const found = [
    tree,
    ...tree.children.flatMap(function walk(node): MindMapNode[] {
      return [node, ...node.children.flatMap(walk)]
    })
  ].find((node) => node.label === label)
  if (!found) throw new Error(`no node labelled ${label}`)
  return found
}

describe('buildMindMap — projection', () => {
  it('roots the map at the note title, never at the first heading', () => {
    const map = buildMindMap([heading('h1', 1, 'Overview')], { rootLabel: 'Quarterly plan' })

    expect(map.tree.kind).toBe('root')
    expect(map.tree.label).toBe('Quarterly plan')
    expect(map.tree.blockId).toBeNull()
    expect(childLabels(map.tree)).toEqual(['Overview'])
  })

  it('branches sub-headings off their parent heading', () => {
    const map = buildMindMap(
      [
        heading('a', 1, 'Alpha'),
        heading('b', 2, 'Alpha one'),
        heading('c', 2, 'Alpha two'),
        heading('d', 1, 'Beta')
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(map.tree)).toEqual(['Alpha', 'Beta'])
    expect(childLabels(labelled(map.tree, 'Alpha'))).toEqual(['Alpha one', 'Alpha two'])
    expect(childLabels(labelled(map.tree, 'Beta'))).toEqual([])
  })

  it('mints no phantom node for a skipped heading level', () => {
    // H1 then H3: the H3 goes one step deeper, and no H2 is invented to sit
    // between them.
    const map = buildMindMap([heading('a', 1, 'Alpha'), heading('b', 3, 'Deep')], {
      rootLabel: 'Note'
    })

    expect(map.nodeCount).toBe(3)
    expect(childLabels(map.tree)).toEqual(['Alpha'])
    const deep = labelled(map.tree, 'Deep')
    expect(childLabels(labelled(map.tree, 'Alpha'))).toEqual(['Deep'])
    // Relative depth is what places it; the level it was written at is kept.
    expect(deep.depth).toBe(2)
    expect(deep.level).toBe(3)
  })

  it('attaches a deep first heading straight to the root', () => {
    const map = buildMindMap([heading('a', 4, 'Details'), heading('b', 5, 'Finer')], {
      rootLabel: 'Note'
    })

    const details = labelled(map.tree, 'Details')
    expect(childLabels(map.tree)).toEqual(['Details'])
    expect(details.depth).toBe(1)
    expect(details.level).toBe(4)
    expect(childLabels(details)).toEqual(['Finer'])
  })

  it('lets content before the first heading attach to the root without minting nodes', () => {
    const map = buildMindMap(
      [
        paragraph('p1', 'A preamble the map does not draw.'),
        paragraph('p2', 'Nor this one.'),
        heading('a', 2, 'First section')
      ],
      { rootLabel: 'Note' }
    )

    expect(map.nodeCount).toBe(2)
    expect(childLabels(map.tree)).toEqual(['First section'])
    expect(labelled(map.tree, 'First section').depth).toBe(1)
  })

  it('finds headings nested inside container blocks', () => {
    const map = buildMindMap(
      [
        heading('a', 1, 'Alpha'),
        {
          id: 'toggle',
          type: 'toggleListItem',
          content: [{ type: 'text', text: 'Collapsed' }],
          children: [heading('b', 2, 'Hidden section')]
        }
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(labelled(map.tree, 'Alpha'))).toEqual(['Hidden section'])
  })

  it('folds a blank heading into the nearest labelled ancestor instead of drawing an empty box', () => {
    const map = buildMindMap(
      [heading('a', 1, 'Alpha'), heading('blank', 2, '   '), heading('c', 3, 'Still visible')],
      { rootLabel: 'Note' }
    )

    expect(map.nodeCount).toBe(3)
    expect(childLabels(labelled(map.tree, 'Alpha'))).toEqual(['Still visible'])
  })

  it('reads a label out of styled, linked and content-less inline shapes', () => {
    const map = buildMindMap(
      [
        {
          id: 'h',
          type: 'heading',
          props: { level: 1 },
          content: [
            { type: 'text', text: 'Ship ' },
            { type: 'link', href: 'https://memry.test', content: [{ type: 'text', text: 'v2' }] },
            { type: 'text', text: ' with ' },
            { type: 'wikiLink', props: { target: 'Roadmap', alias: 'the roadmap' } }
          ]
        }
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(map.tree)).toEqual(['Ship v2 with the roadmap'])
  })

  it('collapses whitespace but never translates or rewrites the label', () => {
    const map = buildMindMap([heading('a', 1, '  Björk\n  &  Co  ')], { rootLabel: '  My note ' })

    expect(map.tree.label).toBe('  My note ')
    expect(childLabels(map.tree)).toEqual(['Björk & Co'])
  })

  it('opens an empty note with the root alone', () => {
    const map = buildMindMap([], { rootLabel: 'Empty' })

    expect(map.isEmpty).toBe(true)
    expect(map.nodeCount).toBe(1)
    expect(map.tree.children).toEqual([])
    expect(map.nodes).toHaveLength(1)
    // Still a drawable map: the root box exists and no connector dangles.
    expect(map.elements).toHaveLength(1)
    expect(map.elements[0]).toMatchObject({ type: 'rectangle', id: map.tree.id })
  })

  it('is not empty as soon as one heading exists', () => {
    const map = buildMindMap([heading('a', 1, 'One')], { rootLabel: 'Note' })
    expect(map.isEmpty).toBe(false)
  })
})

describe('buildMindMap — layout', () => {
  const twoChildren = [heading('a', 1, 'A'), heading('b', 1, 'B')]

  it('places the root on the leading side with its children in the next column', () => {
    const map = buildMindMap(twoChildren, { rootLabel: 'Note' })

    expect(map.nodes.map((node) => [node.label, node.x, node.y, node.width, node.height])).toEqual([
      ['Note', 0, 29, 96, 42],
      ['A', 168, 0, 96, 42],
      ['B', 168, 58, 96, 42]
    ])
    expect(map.bounds).toEqual({ minX: 0, minY: 0, maxX: 264, maxY: 100 })
  })

  it('mirrors the whole map in an RTL locale', () => {
    const map = buildMindMap(twoChildren, { rootLabel: 'Note', direction: 'rtl' })

    expect(map.direction).toBe('rtl')
    expect(map.nodes.map((node) => [node.label, node.x, node.y])).toEqual([
      ['Note', -96, 29],
      ['A', -264, 0],
      ['B', -264, 58]
    ])
    // Same shape, opposite side: children sit before the root in reading order.
    const root = map.nodes[0]
    for (const child of map.nodes.slice(1)) expect(child.x).toBeLessThan(root.x)
  })

  it('keeps every depth in its own column and never overlaps two boxes in one', () => {
    const map = buildMindMap(
      [
        heading('a', 1, 'Alpha'),
        heading('a1', 2, 'Alpha one'),
        heading('a2', 2, 'Alpha two with a considerably longer heading than its sibling'),
        heading('b', 1, 'Beta'),
        heading('b1', 2, 'Beta one'),
        heading('b2', 3, 'Beta one deep')
      ],
      { rootLabel: 'Note' }
    )

    const columns = new Map<number, number[]>()
    for (const node of map.nodes) {
      const xs = columns.get(node.depth) ?? []
      xs.push(node.x)
      columns.set(node.depth, xs)
    }
    // One x per depth.
    for (const xs of columns.values()) expect(new Set(xs).size).toBe(1)
    // Columns advance with depth.
    const xByDepth = [...columns.entries()].sort((l, r) => l[0] - r[0]).map(([, xs]) => xs[0])
    for (let i = 1; i < xByDepth.length; i += 1)
      expect(xByDepth[i]).toBeGreaterThan(xByDepth[i - 1])

    for (const [, xs] of columns) {
      const inColumn = map.nodes.filter((node) => node.x === xs[0]).sort((l, r) => l.y - r.y)
      for (let i = 1; i < inColumn.length; i += 1) {
        expect(inColumn[i].y).toBeGreaterThanOrEqual(inColumn[i - 1].y + inColumn[i - 1].height)
      }
    }
  })

  it('centres a parent on the span of its children', () => {
    const map = buildMindMap(
      [heading('a', 1, 'Alpha'), heading('a1', 2, 'One'), heading('a2', 2, 'Two')],
      { rootLabel: 'Note' }
    )

    const byLabel = new Map(map.nodes.map((node) => [node.label, node]))
    const parent = byLabel.get('Alpha')!
    const first = byLabel.get('One')!
    const last = byLabel.get('Two')!
    const span = (first.y + first.height / 2 + (last.y + last.height / 2)) / 2
    expect(parent.y + parent.height / 2).toBeCloseTo(span, 0)
  })

  it('grows a box taller when its label needs more than one line', () => {
    const map = buildMindMap(
      [
        heading('short', 1, 'Short'),
        heading('long', 1, 'A heading long enough to wrap onto a second line in the map')
      ],
      { rootLabel: 'Note' }
    )

    const byLabel = new Map(map.nodes.map((node) => [node.label, node]))
    const short = byLabel.get('Short')!
    const long = byLabel.get('A heading long enough to wrap onto a second line in the map')!
    expect(long.height).toBeGreaterThan(short.height)
    // Wider too, but only up to the box cap — past that the label wraps.
    expect(long.width).toBeGreaterThan(short.width)
    expect(long.width).toBe(264)
  })

  it('lays the same note out identically on every call', () => {
    const blocks = [
      heading('a', 1, 'Alpha'),
      heading('a1', 3, 'Skipped level'),
      paragraph('p', 'ignored'),
      heading('b', 1, 'Beta'),
      heading('b1', 2, 'Beta one')
    ]

    const first = buildMindMap(blocks, { rootLabel: 'Note' })
    const second = buildMindMap(blocks, { rootLabel: 'Note' })
    const third = buildMindMap(structuredClone(blocks), { rootLabel: 'Note' })

    expect(second).toEqual(first)
    expect(third).toEqual(first)
    // Spelt out because coordinates drifting is the failure that costs the user
    // their spatial memory of their own note.
    expect(second.nodes.map((node) => [node.id, node.x, node.y])).toEqual(
      first.nodes.map((node) => [node.id, node.x, node.y])
    )
  })
})

describe('buildMindMap — elements', () => {
  const map = buildMindMap(
    [heading('a', 1, 'Alpha'), heading('a1', 2, 'Alpha one'), heading('b', 1, 'Beta')],
    { rootLabel: 'Note' }
  )

  it('mints one box per node and one connector per edge', () => {
    const boxes = map.elements.filter((element) => element.type === 'rectangle')
    const edges = map.elements.filter((element) => element.type === 'line')

    expect(boxes).toHaveLength(map.nodeCount)
    expect(edges).toHaveLength(map.nodeCount - 1)
    expect(boxes.map((box) => box.id)).toEqual(map.nodes.map((node) => node.id))
  })

  it('gives every element a unique id and every connector two real endpoints', () => {
    const ids = map.elements.map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)

    const boxIds = new Set(map.nodes.map((node) => node.id))
    for (const element of map.elements) {
      if (element.type !== 'line') continue
      // A connector is named after the child it lands on, and every child in
      // the map has a box; a dangling connector would draw a line to nowhere.
      expect(boxIds.has(element.id.replace(/-edge$/, ''))).toBe(true)
      expect(element.points).toHaveLength(2)
      expect(element.points[0]).toEqual([0, 0])
    }
  })

  it('draws connectors from the parent box to the child box', () => {
    const byId = new Map(map.nodes.map((node) => [node.id, node]))
    for (const element of map.elements) {
      if (element.type !== 'line') continue
      const child = byId.get(element.id.replace(/-edge$/, ''))!
      const parent = byId.get(child.parentId!)!
      expect(element.x).toBe(parent.x + parent.width)
      expect(element.x + element.points[1][0]).toBe(child.x)
    }
  })

  it('carries the label as user content, undecorated', () => {
    const boxes = map.elements.filter((element) => element.type === 'rectangle')
    expect(boxes.map((box) => box.label.text)).toEqual(map.nodes.map((node) => node.label))
  })
})
