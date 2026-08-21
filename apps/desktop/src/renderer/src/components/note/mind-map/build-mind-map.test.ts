/**
 * Every projection and layout rule of the mind map, asserted through the single
 * public entry point and nothing else. No DOM is involved, which is what makes
 * this coverage cheap enough to be exhaustive.
 */

import { describe, expect, it } from 'vitest'
import { buildMindMap } from './build-mind-map'
import type {
  MindMapBoxElement,
  MindMapNode,
  MindMapPositionedNode,
  MindMapSourceBlock
} from './mind-map-types'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

function paragraph(id: string, text: string): MindMapSourceBlock {
  return { id, type: 'paragraph', content: [{ type: 'text', text }] }
}

/** Every block type below is a registered `config.type`, not a guess. */
function listItem(
  type: 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'toggleListItem' | 'callout',
  id: string,
  text: string,
  extra: { props?: Record<string, unknown>; children?: MindMapSourceBlock[] } = {}
): MindMapSourceBlock {
  return {
    id,
    type,
    props: extra.props,
    content: [{ type: 'text', text }],
    children: extra.children
  }
}

function bullet(id: string, text: string, children?: MindMapSourceBlock[]): MindMapSourceBlock {
  return listItem('bulletListItem', id, text, { children })
}

function taskBlock(id: string, title: string, checked = false): MindMapSourceBlock {
  return { id, type: 'taskBlock', props: { taskId: `t-${id}`, title, checked } }
}

/** A translator stand-in: deterministic, and never the shape a locale file has. */
function formatContentCount(kind: string, count: number): string {
  return `${count} ${kind}`
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

  it('keeps a heading written inside a container inside it', () => {
    // The toggle is a node of its own now, so the heading it holds stays where
    // it was written rather than being hoisted out and leaving its own
    // contents behind under a container it no longer belongs to.
    const map = buildMindMap(
      [
        heading('a', 1, 'Alpha'),
        {
          id: 'toggle',
          type: 'toggleListItem',
          content: [{ type: 'text', text: 'Collapsed' }],
          children: [heading('b', 2, 'Hidden section'), bullet('b1', 'Inside the section')]
        }
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(labelled(map.tree, 'Alpha'))).toEqual(['Collapsed'])
    expect(childLabels(labelled(map.tree, 'Collapsed'))).toEqual(['Hidden section'])
    expect(childLabels(labelled(map.tree, 'Hidden section'))).toEqual(['Inside the section'])
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

describe('buildMindMap — deep links', () => {
  const blocks = [heading('a', 1, 'Alpha'), heading('a1', 2, 'Alpha one')]

  function boxes(map: ReturnType<typeof buildMindMap>): Map<string, { link?: string }> {
    return new Map(
      map.elements
        .filter((element) => element.type === 'rectangle')
        .map((box) => [box.id, box] as const)
    )
  }

  it('draws no links at all without a note to point at', () => {
    const map = buildMindMap(blocks, { rootLabel: 'Note' })
    for (const box of boxes(map).values()) expect(box.link).toBeUndefined()
  })

  it('anchors a heading box at its own block', () => {
    const map = buildMindMap(blocks, { rootLabel: 'Note', noteId: 'note-1' })
    const alpha = map.nodes.find((node) => node.label === 'Alpha')!

    // A block anchor: exact, and meaningful only in the session that minted it.
    expect(boxes(map).get(alpha.id)?.link).toBe('memry://note/note-1#^a')
  })

  it('anchors the root at nothing, because the title is not a block', () => {
    const map = buildMindMap(blocks, { rootLabel: 'Note', noteId: 'note-1' })
    const root = map.nodes.find((node) => node.kind === 'root')!

    // No fragment — which reads as "this note, from the top".
    expect(boxes(map).get(root.id)?.link).toBe('memry://note/note-1')
  })

  it('links every box and no connector', () => {
    const map = buildMindMap(blocks, { rootLabel: 'Note', noteId: 'note-1' })
    for (const element of map.elements) {
      if (element.type === 'rectangle') expect(element.link).toMatch(/^memry:\/\/note\/note-1/)
      else expect(element).not.toHaveProperty('link')
    }
  })

  it('lays out identically whether or not the boxes carry links', () => {
    const withoutLinks = buildMindMap(blocks, { rootLabel: 'Note' })
    const withLinks = buildMindMap(blocks, { rootLabel: 'Note', noteId: 'note-1' })

    // A link is an attribute of a box, never an input to where it sits.
    expect(withLinks.nodes).toEqual(withoutLinks.nodes)
    expect(withLinks.bounds).toEqual(withoutLinks.bounds)
  })
})

describe('buildMindMap — lists, tasks and containers', () => {
  it('branches bullet, numbered and checklist items off the heading above them', () => {
    const map = buildMindMap(
      [
        heading('h', 1, 'Today'),
        bullet('b', 'A loose thought'),
        listItem('numberedListItem', 'n', 'A step'),
        listItem('checkListItem', 'c', 'A box to tick')
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(labelled(map.tree, 'Today'))).toEqual([
      'A loose thought',
      '1. A step',
      'A box to tick'
    ])
    expect(labelled(map.tree, 'Today').children.map((child) => child.kind)).toEqual([
      'bullet',
      'numbered',
      'check'
    ])
  })

  it('numbers a run of items and starts a new run when something interrupts it', () => {
    const map = buildMindMap(
      [
        heading('h', 1, 'Steps'),
        listItem('numberedListItem', 'n1', 'First'),
        listItem('numberedListItem', 'n2', 'Second'),
        paragraph('p', 'An aside, which ends the list.'),
        listItem('numberedListItem', 'n3', 'First again')
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(labelled(map.tree, 'Steps'))).toEqual([
      '1. First',
      '2. Second',
      '1. First again'
    ])
  })

  it('starts a numbered run where the user moved it to', () => {
    const map = buildMindMap(
      [
        listItem('numberedListItem', 'n1', 'Five', { props: { start: 5 } }),
        listItem('numberedListItem', 'n2', 'Six')
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(map.tree)).toEqual(['5. Five', '6. Six'])
  })

  it('branches a nested list item off its parent item, not off the heading', () => {
    const map = buildMindMap(
      [
        heading('h', 1, 'Section'),
        bullet('b1', 'Parent', [bullet('b2', 'Child', [bullet('b3', 'Grandchild')])]),
        bullet('b4', 'Sibling')
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(labelled(map.tree, 'Section'))).toEqual(['Parent', 'Sibling'])
    expect(childLabels(labelled(map.tree, 'Parent'))).toEqual(['Child'])
    expect(childLabels(labelled(map.tree, 'Child'))).toEqual(['Grandchild'])
    expect(labelled(map.tree, 'Grandchild').depth).toBe(4)
  })

  it('draws a task block from its title and follows its tick', () => {
    const map = buildMindMap(
      [
        heading('h', 1, 'Commitments'),
        taskBlock('t1', 'Write the spec'),
        taskBlock('t2', 'Ship it', true)
      ],
      { rootLabel: 'Note' }
    )

    const tasks = labelled(map.tree, 'Commitments').children
    expect(tasks.map((task) => [task.kind, task.label, task.isDone])).toEqual([
      ['task', 'Write the spec', false],
      ['task', 'Ship it', true]
    ])
  })

  it('branches a toggle and a callout into their children rather than flattening them', () => {
    const map = buildMindMap(
      [
        listItem('toggleListItem', 'tg', 'Collapsed in the editor', {
          children: [bullet('tb', 'Still discoverable here')]
        }),
        listItem('callout', 'co', 'Watch out', {
          props: { type: 'warning' },
          children: [
            listItem('checkListItem', 'cc', 'A checklist inside it', { props: { checked: true } })
          ]
        })
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(map.tree)).toEqual(['Collapsed in the editor', 'Watch out'])
    expect(labelled(map.tree, 'Collapsed in the editor').kind).toBe('toggle')
    expect(childLabels(labelled(map.tree, 'Collapsed in the editor'))).toEqual([
      'Still discoverable here'
    ])
    expect(labelled(map.tree, 'Watch out').kind).toBe('callout')
    expect(childLabels(labelled(map.tree, 'Watch out'))).toEqual(['A checklist inside it'])
    expect(labelled(map.tree, 'A checklist inside it').isDone).toBe(true)
  })

  it('carries the source block on every node, which is what navigation lands on', () => {
    const map = buildMindMap(
      [
        heading('h', 1, 'Section'),
        bullet('b', 'A bullet'),
        taskBlock('t', 'A task'),
        listItem('toggleListItem', 'tg', 'A toggle')
      ],
      { rootLabel: 'Note' }
    )

    expect(map.nodes.map((positioned) => positioned.blockId)).toEqual([null, 'h', 'b', 't', 'tg'])
  })

  it('folds an item with nothing to show and keeps what was under it', () => {
    const map = buildMindMap(
      [heading('h', 1, 'Section'), bullet('blank', '   ', [bullet('kept', 'Still here')])],
      { rootLabel: 'Note' }
    )

    expect(childLabels(labelled(map.tree, 'Section'))).toEqual(['Still here'])
  })
})

describe('buildMindMap — tags and content badges', () => {
  it('turns an inline tag into a badge on its node rather than a node of its own', () => {
    const map = buildMindMap(
      [
        {
          id: 'h',
          type: 'heading',
          props: { level: 1 },
          content: [
            { type: 'text', text: 'Plan ' },
            { type: 'hashTag', props: { tag: 'q3', color: 'red', icon: '' } },
            { type: 'text', text: ' review ' },
            { type: 'hashTag', props: { tag: 'ops' } },
            { type: 'hashTag', props: { tag: 'q3' } }
          ]
        }
      ],
      { rootLabel: 'Note' }
    )

    const section = labelled(map.tree, 'Plan review')
    expect(map.nodeCount).toBe(2)
    // Out of the label, onto the node — and a tag written twice reads once.
    expect(section.tags).toEqual(['q3', 'ops'])
    expect(section.detail).toBe('#q3 #ops')
  })

  it('counts content on the node above it instead of drawing a node for it', () => {
    const map = buildMindMap(
      [
        heading('h', 1, 'Section'),
        { id: 'tbl', type: 'table', content: { type: 'tableContent', rows: [] } },
        { id: 'code1', type: 'codeBlock', content: [{ type: 'text', text: 'const a = 1' }] },
        { id: 'code2', type: 'codeBlock', content: [{ type: 'text', text: 'const b = 2' }] },
        { id: 'img', type: 'image', props: { url: 'a.png' } },
        { id: 'q', type: 'quote', content: [{ type: 'text', text: 'A quotation.' }] },
        { id: 'yt', type: 'youtubeEmbed', props: { videoId: 'abc' } },
        { id: 'vid', type: 'video', props: { url: 'a.mp4' } },
        { id: 'aud', type: 'audio', props: { url: 'a.mp3' } },
        { id: 'bk', type: 'bookmark', props: { url: 'https://memry.test' } },
        { id: 'fl', type: 'file', props: { url: 'a.pdf', name: 'a.pdf' } }
      ],
      { rootLabel: 'Note', formatContentCount }
    )

    // Root plus the heading. Nothing above became a node of its own.
    expect(map.nodeCount).toBe(2)
    const section = labelled(map.tree, 'Section')
    expect(section.contents).toEqual([
      { kind: 'table', count: 1 },
      { kind: 'code', count: 2 },
      { kind: 'image', count: 1 },
      { kind: 'quote', count: 1 },
      // youtubeEmbed, video and audio all read as an embed.
      { kind: 'embed', count: 3 },
      { kind: 'bookmark', count: 1 },
      { kind: 'file', count: 1 }
    ])
    expect(section.detail).toBe(
      '1 table · 2 code · 1 image · 1 quote · 3 embed · 1 bookmark · 1 file'
    )
    // On the box the reader can see, not only in the data behind it.
    const box = map.elements.find(
      (element) => element.type === 'rectangle' && element.id === section.id
    )
    expect(box?.type === 'rectangle' && box.label.text).toBe(`Section\n${section.detail}`)
  })

  it('counts content against the container holding it, and the root before any heading', () => {
    const map = buildMindMap(
      [
        { id: 'img', type: 'image', props: { url: 'a.png' } },
        heading('h', 1, 'Section'),
        listItem('toggleListItem', 'tg', 'A toggle', {
          children: [{ id: 'code', type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }]
        })
      ],
      { rootLabel: 'Note', formatContentCount }
    )

    expect(map.tree.detail).toBe('1 image')
    expect(labelled(map.tree, 'Section').detail).toBe('')
    expect(labelled(map.tree, 'A toggle').detail).toBe('1 code')
  })

  it('keeps the counts and loses only their wording when no formatter is supplied', () => {
    const map = buildMindMap(
      [heading('h', 1, 'Section'), { id: 'tbl', type: 'table', content: { rows: [] } }],
      { rootLabel: 'Note' }
    )

    const section = labelled(map.tree, 'Section')
    expect(section.contents).toEqual([{ kind: 'table', count: 1 }])
    expect(section.detail).toBe('')
  })

  it('keeps date mentions, link mentions and inline images as plain label text', () => {
    const map = buildMindMap(
      [
        {
          id: 'h',
          type: 'heading',
          props: { level: 1 },
          content: [
            { type: 'text', text: 'Due ' },
            { type: 'dateMention', props: { dateISO: '2026-08-21', hasTime: false } },
            { type: 'text', text: ' per ' },
            {
              type: 'linkMention',
              props: { url: 'https://memry.test/x', domain: 'memry.test', title: 'the brief' }
            },
            { type: 'text', text: ' see ' },
            { type: 'inlineImage', props: { src: 'chart.png', alt: 'the chart', width: 0 } }
          ]
        },
        paragraph('p', 'A paragraph never becomes a node.')
      ],
      { rootLabel: 'Note' }
    )

    expect(map.nodeCount).toBe(2)
    expect(childLabels(map.tree)).toEqual(['Due 2026-08-21 per the brief see the chart'])
  })

  it('lets the badge line widen and heighten the box that carries it', () => {
    const plain = buildMindMap([heading('h', 1, 'Section')], { rootLabel: 'Note' })
    const badged = buildMindMap(
      [heading('h', 1, 'Section'), { id: 'tbl', type: 'table', content: { rows: [] } }],
      { rootLabel: 'Note', formatContentCount: () => 'a considerably longer badge line' }
    )

    expect(badged.nodes[1].height).toBeGreaterThan(plain.nodes[1].height)
    expect(badged.nodes[1].width).toBeGreaterThan(plain.nodes[1].width)
  })
})

describe('buildMindMap — completed items', () => {
  const map = buildMindMap(
    [
      heading('h', 1, 'Commitments'),
      taskBlock('open', 'Still to do'),
      taskBlock('done', 'Already done', true),
      listItem('checkListItem', 'ticked', 'Ticked off', { props: { checked: true } })
    ],
    { rootLabel: 'Note' }
  )

  function boxOf(label: string): {
    positioned: MindMapPositionedNode
    box: MindMapBoxElement
  } {
    const positioned = map.nodes.find((candidate) => candidate.label === label)
    if (!positioned) throw new Error(`no node labelled ${label}`)
    const box = map.elements.find(
      (element) => element.type === 'rectangle' && element.id === positioned.id
    )
    if (box?.type !== 'rectangle') throw new Error(`no box for ${label}`)
    return { positioned, box }
  }

  it('dims a completed item and leaves an open one alone', () => {
    const open = boxOf('Still to do')
    const done = boxOf('Already done')

    expect(done.box.label.strokeColor).not.toBe(open.box.label.strokeColor)
    expect(done.box.strokeColor).not.toBe(open.box.strokeColor)
    expect(done.box.backgroundColor).not.toBe(open.box.backgroundColor)
  })

  it('rules a completed label through, because the surface has no text decorations', () => {
    const open = boxOf('Still to do')
    const strikes = map.elements.filter((element) => element.id.includes('-strike-'))

    expect(strikes.map((strike) => strike.id).sort()).toEqual([
      'mm-done-strike-1',
      'mm-ticked-strike-1'
    ])
    expect(
      map.elements.some((element) => element.id.startsWith(`${open.positioned.id}-strike`))
    ).toBe(false)

    // Horizontal, over the label, inside the box it belongs to.
    for (const label of ['Already done', 'Ticked off']) {
      const { positioned } = boxOf(label)
      const strike = strikes.find((candidate) => candidate.id.startsWith(`${positioned.id}-`))
      if (strike?.type !== 'line') throw new Error(`no rule over ${label}`)
      expect(strike.points[1][1]).toBe(0)
      expect(strike.x).toBeGreaterThan(positioned.x)
      expect(strike.y).toBeGreaterThan(positioned.y)
      expect(strike.y).toBeLessThan(positioned.y + positioned.height)
      expect(strike.x + strike.points[1][0]).toBeLessThanOrEqual(positioned.x + positioned.width)
    }
  })

  it('mirrors the rule with the reading direction', () => {
    const rtl = buildMindMap([taskBlock('done', 'Already done', true)], {
      rootLabel: 'Note',
      direction: 'rtl'
    })

    const positioned = rtl.nodes.find((candidate) => candidate.label === 'Already done')
    const strike = rtl.elements.find((element) => element.id === 'mm-done-strike-1')
    if (!positioned || strike?.type !== 'line') throw new Error('no rule in the RTL map')
    // Hard against the trailing padding edge, which in RTL is where the text starts.
    expect(strike.x).toBeGreaterThanOrEqual(positioned.x)
    expect(strike.x + strike.points[1][0]).toBeLessThanOrEqual(positioned.x + positioned.width)
  })
})
