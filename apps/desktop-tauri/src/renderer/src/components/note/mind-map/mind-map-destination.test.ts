/**
 * What a node says it opens.
 *
 * Driven through `buildMindMap` wherever the case allows it, so the nodes under
 * test are the ones the map really draws rather than a hand-made idea of them.
 * The one exception is called out where it appears.
 */

import { describe, expect, it } from 'vitest'
import { buildMindMap } from './build-mind-map'
import { mindMapDestination, mindMapDestinations } from './mind-map-destination'
import type { MindMapPositionedNode, MindMapSourceBlock } from './mind-map-types'

const SEP = { separator: '→' }

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

function bullet(id: string, text: string): MindMapSourceBlock {
  return { id, type: 'bulletListItem', content: [{ type: 'text', text }] }
}

function chainOf(map: ReturnType<typeof buildMindMap>, label: string): string {
  const byId = new Map(map.nodes.map((node) => [node.id, node]))
  const node = map.nodes.find((candidate) => candidate.label === label)
  if (!node) throw new Error(`no node labelled ${label}`)
  return mindMapDestination(node, byId, SEP)
}

describe('mindMapDestination — a place in this note', () => {
  const map = buildMindMap([heading('b-h', 1, 'Q3 Risks'), bullet('b-i', 'Hire a designer')], {
    rootLabel: 'Planning',
    noteId: 'n1'
  })

  it('names the note, and nothing else, for the root', () => {
    expect(chainOf(map, 'Planning')).toBe('Planning')
  })

  it('names the path down to a heading', () => {
    expect(chainOf(map, 'Q3 Risks')).toBe('Planning → Q3 Risks')
  })

  it('keeps the last two steps and says that there were more', () => {
    // The question a hover answers is "where will I land"; the nearest ancestor
    // and the target answer it, and a six-level path overflows the line.
    expect(chainOf(map, 'Hire a designer')).toBe('… → Q3 Risks → Hire a designer')
  })

  it('keeps a numbered item’s number, which is part of what the user wrote', () => {
    const numbered = buildMindMap(
      [
        heading('b-h', 1, 'Steps'),
        { id: 'b-1', type: 'numberedListItem', content: [{ type: 'text', text: 'Prepare' }] },
        { id: 'b-2', type: 'numberedListItem', content: [{ type: 'text', text: 'Ship' }] }
      ],
      { rootLabel: 'Planning', noteId: 'n1' }
    )
    expect(chainOf(numbered, '2. Ship')).toBe('… → Steps → 2. Ship')
  })

  it('steps over a blank heading rather than drawing a gap for it', () => {
    // A blank heading mints no box and never joins the level stack, so its
    // children legitimately have one step fewer.
    const blank = buildMindMap(
      [heading('b-h', 1, 'Q3 Risks'), heading('b-blank', 2, ''), bullet('b-i', 'Hire')],
      { rootLabel: 'Planning', noteId: 'n1' }
    )
    expect(chainOf(blank, 'Hire')).toBe('… → Q3 Risks → Hire')
  })

  it('translates only the separator, never the words around it', () => {
    // The names are the user's own; the arrow between them is chrome, and an
    // RTL locale hands one that points the way that locale reads.
    expect(chainOf(map, 'Hire a designer')).toContain('Q3 Risks')
    const rtl = buildMindMap([heading('b-h', 1, 'Q3 Risks'), bullet('b-i', 'Hire a designer')], {
      rootLabel: 'Planning',
      noteId: 'n1'
    })
    const byId = new Map(rtl.nodes.map((node) => [node.id, node]))
    const node = rtl.nodes.find((candidate) => candidate.label === 'Hire a designer')!
    expect(mindMapDestination(node, byId, { separator: '←' })).toBe(
      '… ← Q3 Risks ← Hire a designer'
    )
  })

  it('never runs past the link bubble’s own budget', () => {
    const long = buildMindMap([heading('b-h', 1, 'A'.repeat(40)), bullet('b-i', 'B'.repeat(40))], {
      rootLabel: 'Planning',
      noteId: 'n1'
    })
    // 48 characters, the same clip `linkBubbleLabel`'s bubble is written for —
    // shared as a function rather than copied as a number.
    expect(chainOf(long, 'B'.repeat(40)).length).toBeLessThanOrEqual(48)
  })
})

describe('mindMapDestination — heading segments come from the unclipped text', () => {
  it('is a real trap: the pipeline clips a long heading’s label', () => {
    const map = buildMindMap([heading('b-h', 1, 'H'.repeat(90))], {
      rootLabel: 'Planning',
      noteId: 'n1'
    })
    const node = map.nodes.find((candidate) => candidate.kind === 'heading')!

    // `label` is a display string and has been shortened; `headingText` is kept
    // whole precisely so an anchor — and now a name — is built from the truth.
    expect(node.label.endsWith('…')).toBe(true)
    expect(node.headingText).toBe('H'.repeat(90))
  })

  it('reads `headingText` rather than `label`', () => {
    // Hand-built on purpose, and the only place in this file that is. Under the
    // 48-character budget the two strings can only diverge past the point where
    // both are already clipped, so the rule is asserted where it is visible:
    // directly, on a node whose two fields disagree.
    const node: MindMapPositionedNode = {
      id: 'mm-h',
      blockId: 'b-h',
      label: 'Clipped…',
      kind: 'heading',
      level: 1,
      depth: 1,
      isDone: false,
      taskId: null,
      wikiTarget: null,
      headingText: 'The whole heading',
      tags: [],
      contents: [],
      foldedCount: 0,
      detail: '',
      parentId: null,
      x: 0,
      y: 0,
      width: 10,
      height: 10
    }

    expect(mindMapDestination(node, new Map([[node.id, node]]), SEP)).toBe('The whole heading')
  })
})

describe('mindMapDestination — nodes that are not a place in this note', () => {
  const map = buildMindMap(
    [
      heading('b-h', 1, 'Q3 Risks'),
      {
        id: 'b-i',
        type: 'bulletListItem',
        content: [
          { type: 'text', text: 'Read ' },
          { type: 'wikiLink', props: { target: 'Roadmap#Q3' } }
        ]
      }
    ],
    { rootLabel: 'Planning', noteId: 'n1' }
  )

  function wikiChain(target: string): string {
    const linked = buildMindMap(
      [
        heading('b-h', 1, 'Q3 Risks'),
        {
          id: 'b-i',
          type: 'bulletListItem',
          content: [
            { type: 'text', text: 'Read ' },
            { type: 'wikiLink', props: { target } }
          ]
        }
      ],
      { rootLabel: 'Planning', noteId: 'n1' }
    )
    const byId = new Map(linked.nodes.map((node) => [node.id, node]))
    const node = linked.nodes.find((candidate) => candidate.kind === 'wikiLink')!
    return mindMapDestination(node, byId, SEP)
  }

  it('names the note a wiki link points AT, never the note the map is of', () => {
    // Naming this note here would be zero information: the reader is in it. It
    // is also the case a user hits most often, because a wiki node is the one
    // worth hovering.
    const chain = mindMapDestinations(map.nodes, SEP).get(
      map.nodes.find((node) => node.kind === 'wikiLink')!.id
    )
    expect(chain).toBe('Roadmap → Q3')
    expect(chain).not.toContain('Planning')
  })

  it('names just the note when the link carries no heading', () => {
    expect(wikiChain('Roadmap')).toBe('Roadmap')
  })

  it('drops a block reference, which is the machine identifier this replaces', () => {
    expect(wikiChain('Roadmap#^b3')).toBe('Roadmap')
  })

  it('keeps a note whose title really contains a hash', () => {
    // `Sprint #4` is a note somebody may really have, so the raw target is the
    // fallback when splitting leaves nothing to name.
    expect(wikiChain('#')).toBe('#')
  })

  it('names the branch a fold marker stands for, not the marker', () => {
    const folded = buildMindMap(
      [
        heading('b-h', 1, 'Q3 Risks'),
        ...Array.from({ length: 13 }, (_, index) => bullet(`b-${index}`, `Item ${index}`))
      ],
      { rootLabel: 'Planning', noteId: 'n1', formatMore: (count) => `+${count} more` }
    )
    const byId = new Map(folded.nodes.map((node) => [node.id, node]))
    const marker = folded.nodes.find((node) => node.kind === 'more')!

    // Activating it opens the branch; in a saved canvas its link opens the note
    // at the section the missing rows live in. Both are "under Q3 Risks", and
    // neither is "+2 more".
    expect(mindMapDestination(marker, byId, SEP)).toBe('Planning → Q3 Risks')
  })

  it('names a task node by the path down to it', () => {
    const tasks = buildMindMap(
      [
        heading('b-h', 1, 'Q3 Risks'),
        { id: 'b-t', type: 'taskBlock', props: { taskId: 't-7', title: 'Cut the build' } }
      ],
      { rootLabel: 'Planning', noteId: 'n1' }
    )
    // The last segment IS the task's name, which is what a click on it opens.
    expect(chainOf(tasks, 'Cut the build')).toBe('… → Q3 Risks → Cut the build')
  })
})

describe('mindMapDestinations', () => {
  it('answers for every node the map drew', () => {
    const map = buildMindMap([heading('b-h', 1, 'Q3 Risks'), bullet('b-i', 'Hire')], {
      rootLabel: 'Planning',
      noteId: 'n1'
    })
    const all = mindMapDestinations(map.nodes, SEP)

    expect(all.size).toBe(map.nodes.length)
    for (const chain of all.values()) expect(chain).not.toBe('')
  })
})
