/**
 * Wiki links as branches of their own, asserted through the single public entry
 * point — a sibling of `build-mind-map.test.ts` rather than more of it, because
 * that file is already at the size where nobody reads to the end.
 *
 * The rule under test throughout: a wiki link is not part of this note. It
 * leaves the label that held it and becomes a leaf, exactly the way a hash tag
 * leaves the label and becomes a badge.
 */

import { describe, expect, it } from 'vitest'
import { buildMindMap } from './build-mind-map'
import type {
  MindMapBoxElement,
  MindMapNode,
  MindMapPositionedNode,
  MindMapSourceBlock
} from './mind-map-types'

/** The inline shape a `[[…]]` really has: content-less, text in props. */
function wikiLink(target: string, alias?: string): Record<string, unknown> {
  return { type: 'wikiLink', props: { target, alias: alias ?? '' } }
}

function text(value: string): Record<string, unknown> {
  return { type: 'text', text: value }
}

function heading(id: string, level: number, content: unknown[]): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content }
}

function bullet(
  id: string,
  content: unknown[],
  children?: MindMapSourceBlock[]
): MindMapSourceBlock {
  return { id, type: 'bulletListItem', content, children }
}

function paragraph(id: string, content: unknown[]): MindMapSourceBlock {
  return { id, type: 'paragraph', content }
}

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

function positioned(map: ReturnType<typeof buildMindMap>, label: string): MindMapPositionedNode {
  const found = map.nodes.find((node) => node.label === label)
  if (!found) throw new Error(`no node labelled ${label}`)
  return found
}

function boxFor(map: ReturnType<typeof buildMindMap>, label: string): MindMapBoxElement {
  const id = positioned(map, label).id
  const box = map.elements.find(
    (element): element is MindMapBoxElement => element.type === 'rectangle' && element.id === id
  )
  if (!box) throw new Error(`no box for ${label}`)
  return box
}

describe('buildMindMap — wiki links become nodes', () => {
  it('branches a link written in a heading off that heading', () => {
    const map = buildMindMap([heading('h', 1, [text('See '), wikiLink('Roadmap')])], {
      rootLabel: 'Note'
    })

    // The words around it stay; the link itself is no longer part of them.
    expect(childLabels(map.tree)).toEqual(['See'])
    const section = labelled(map.tree, 'See')
    expect(childLabels(section)).toEqual(['Roadmap'])
    expect(section.children[0].kind).toBe('wikiLink')
  })

  it('branches a link written in a list item off that item', () => {
    const map = buildMindMap(
      [heading('h', 1, [text('Section')]), bullet('b', [text('Ask '), wikiLink('Priya')])],
      { rootLabel: 'Note' }
    )

    const item = labelled(map.tree, 'Ask')
    expect(item.kind).toBe('bullet')
    expect(childLabels(item)).toEqual(['Priya'])
    expect(item.children[0].kind).toBe('wikiLink')
  })

  it('branches a link written in a paragraph off the node the paragraph belongs to', () => {
    const map = buildMindMap(
      [
        heading('h', 1, [text('Background')]),
        paragraph('p', [text('Grew out of '), wikiLink('Old plan'), text(' last spring.')])
      ],
      { rootLabel: 'Note' }
    )

    // The paragraph is still no node — but what it reaches is not lost with it.
    expect(childLabels(labelled(map.tree, 'Background'))).toEqual(['Old plan'])
    expect(map.nodeCount).toBe(3)
  })

  it('turns an item that is nothing but a link into the link itself', () => {
    const map = buildMindMap(
      [
        heading('h', 1, [text('Projects')]),
        bullet('b1', [wikiLink('Alpha')]),
        bullet('b2', [wikiLink('Beta')])
      ],
      { rootLabel: 'Note' }
    )

    // A list of links is a fan of links, never a fan of empty boxes each
    // holding one.
    const projects = labelled(map.tree, 'Projects')
    expect(childLabels(projects)).toEqual(['Alpha', 'Beta'])
    expect(projects.children.map((child) => child.kind)).toEqual(['wikiLink', 'wikiLink'])
    expect(map.nodeCount).toBe(4)
  })

  it('shows the alias and opens the target', () => {
    const map = buildMindMap([bullet('b', [wikiLink('2026-Q3-roadmap', 'the roadmap')])], {
      rootLabel: 'Note'
    })

    const link = map.tree.children[0]
    // What the note shows is what the map draws; what it opens is what was
    // written, heading half and all.
    expect(link.label).toBe('the roadmap')
    expect(link.wikiTarget).toBe('2026-Q3-roadmap')
  })

  it('keeps the heading half of a target, which is where a link lands', () => {
    const map = buildMindMap([bullet('b', [wikiLink('Roadmap#Q3')])], { rootLabel: 'Note' })

    expect(map.tree.children[0].wikiTarget).toBe('Roadmap#Q3')
  })

  it('draws one node for a link repeated in the same block, and two for two readings of it', () => {
    const repeated = buildMindMap([bullet('b', [wikiLink('Alpha'), wikiLink('Alpha')])], {
      rootLabel: 'Note'
    })
    const aliased = buildMindMap(
      [bullet('b', [wikiLink('Alpha', 'first'), wikiLink('Alpha', 'second')])],
      { rootLabel: 'Note' }
    )

    expect(childLabels(repeated.tree)).toEqual(['Alpha'])
    // Two different words for the same note are two things the note says.
    expect(childLabels(aliased.tree)).toEqual(['first', 'second'])
  })

  it('is always a leaf, and never a place in this note', () => {
    const map = buildMindMap(
      [bullet('b', [text('Read '), wikiLink('Roadmap')], [bullet('b-kid', [text('Then this')])])],
      { rootLabel: 'Note' }
    )

    const link = labelled(map.tree, 'Roadmap')
    expect(link.children).toEqual([])
    // Null on purpose: `blockId` is what a click navigates to, so a link
    // carrying its sentence's block id would scroll to the sentence.
    expect(link.blockId).toBeNull()
    expect(link.level).toBeNull()
    expect(link.isDone).toBe(false)
    expect(link.taskId).toBeNull()
  })

  it('leaves every other node kind with no wiki target of its own', () => {
    const map = buildMindMap(
      [heading('h', 1, [text('Section')]), bullet('b', [text('Item '), wikiLink('Elsewhere')])],
      { rootLabel: 'Note' }
    )

    for (const node of map.nodes) {
      expect(node.wikiTarget).toBe(node.kind === 'wikiLink' ? 'Elsewhere' : null)
    }
  })

  it('hands a link up when the heading that held it draws no box', () => {
    const map = buildMindMap(
      [
        heading('a', 1, [text('Alpha')]),
        heading('link-only', 2, [wikiLink('Roadmap')]),
        heading('c', 2, [text('Gamma')])
      ],
      { rootLabel: 'Note' }
    )

    // The heading had nothing of its own to say, so it folds the way a blank
    // one does — but what it reached out to is still on the map.
    const alpha = labelled(map.tree, 'Alpha')
    expect(childLabels(alpha)).toEqual(['Roadmap', 'Gamma'])
  })

  it('reads a link inside a container against that container, not the note', () => {
    const map = buildMindMap(
      [
        heading('h', 1, [text('Section')]),
        {
          id: 'cal',
          type: 'callout',
          content: [text('Watch out')],
          children: [paragraph('p', [wikiLink('Incident log')])]
        }
      ],
      { rootLabel: 'Note' }
    )

    expect(childLabels(labelled(map.tree, 'Watch out'))).toEqual(['Incident log'])
  })

  it('mints a link in document order, before the blocks written under it', () => {
    const map = buildMindMap(
      [bullet('b', [text('Ship '), wikiLink('v2')], [bullet('b-kid', [text('Sub-item')])])],
      { rootLabel: 'Note' }
    )

    expect(childLabels(labelled(map.tree, 'Ship'))).toEqual(['v2', 'Sub-item'])
  })
})

describe('buildMindMap — wiki links are drawn apart from the note', () => {
  const map = buildMindMap(
    [heading('h', 1, [text('Section')]), bullet('b', [text('Read '), wikiLink('Roadmap')])],
    { rootLabel: 'Note', noteId: 'note-1' }
  )

  it('draws a link in its own colour and with a dashed outline', () => {
    const link = boxFor(map, 'Roadmap')
    const structure = boxFor(map, 'Section')

    expect(link.strokeColor).not.toBe(structure.strokeColor)
    expect(link.backgroundColor).not.toBe(structure.backgroundColor)
    expect(link.label.strokeColor).not.toBe(structure.label.strokeColor)
    // A second difference that survives colour blindness and a grey printout.
    expect(link.strokeStyle).toBe('dashed')
    expect(structure.strokeStyle).toBeUndefined()
  })

  it('gives a link box a handle of its own, never the one its sentence carries', () => {
    const link = boxFor(map, 'Roadmap')
    const sentence = boxFor(map, 'Read')

    // In view mode the whole box is the link's hit area, so two boxes sharing
    // one href would send a click to whichever came first.
    expect(link.link).not.toBe(sentence.link)
    expect(sentence.link).toBe('memry://note/note-1#^b')
    expect(link.link).toBe(`memry://note/note-1#^${positioned(map, 'Roadmap').id}`)
  })

  it('keeps the href of every box unique', () => {
    const hrefs = map.elements
      .filter((element): element is MindMapBoxElement => element.type === 'rectangle')
      .map((box) => box.link)

    expect(new Set(hrefs).size).toBe(hrefs.length)
  })
})

describe('buildMindMap — task nodes carry their task', () => {
  it('carries the id a task block was written with', () => {
    const map = buildMindMap(
      [{ id: 'tb', type: 'taskBlock', props: { taskId: 't-7', title: 'Cut the build' } }],
      { rootLabel: 'Note' }
    )

    const task = labelled(map.tree, 'Cut the build')
    expect(task.kind).toBe('task')
    expect(task.taskId).toBe('t-7')
    // The block is still known: a task with no id has to land somewhere.
    expect(task.blockId).toBe('tb')
  })

  it('says so rather than inventing one when the block carries none', () => {
    const map = buildMindMap(
      [{ id: 'tb', type: 'taskBlock', props: { taskId: '', title: 'Older build' } }],
      { rootLabel: 'Note' }
    )

    expect(labelled(map.tree, 'Older build').taskId).toBeNull()
  })
})
