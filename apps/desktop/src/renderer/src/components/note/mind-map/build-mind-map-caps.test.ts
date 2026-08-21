/**
 * The caps, and what happens AT a cap — asserted through the one public entry
 * point, with no DOM anywhere.
 *
 * The cap values themselves are never spelled out here. A test that repeats
 * `12` is a test that has to be edited when the number changes, and it stops
 * saying what it meant; these import the caps and assert the behaviour around
 * them instead.
 *
 * The load-bearing test in this file is the last one. Every other case checks
 * one cap; that one checks the promise the whole ticket rests on — that a block
 * which would have been a node is either DRAWN exactly once or COUNTED exactly
 * once, and never simply gone.
 */

import { describe, expect, it } from 'vitest'
import { buildMindMap } from './build-mind-map'
import {
  MIND_MAP_MAX_CHILDREN,
  MIND_MAP_MAX_DEPTH,
  MIND_MAP_MAX_LABEL_CHARS,
  MIND_MAP_MAX_NODES
} from './mind-map-caps'
import type { MindMapNode, MindMapOptions, MindMapSourceBlock } from './mind-map-types'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

function bullet(id: string, text: string, children?: MindMapSourceBlock[]): MindMapSourceBlock {
  return { id, type: 'bulletListItem', content: [{ type: 'text', text }], children }
}

function toggle(id: string, text: string, children: MindMapSourceBlock[]): MindMapSourceBlock {
  return { id, type: 'toggleListItem', content: [{ type: 'text', text }], children }
}

/** Stand-ins for the app's translator: deterministic, and never a locale shape. */
const formatMore = (count: number): string => `+${count} more`
const formatContentCount = (kind: string, count: number): string => `${count} ${kind}`

/** Everything the app passes, so the wording under test is the wording shipped. */
const TRANSLATED: MindMapOptions = { rootLabel: 'Note', formatMore, formatContentCount }

function walk(node: MindMapNode): MindMapNode[] {
  return [node, ...node.children.flatMap(walk)]
}

function labelled(tree: MindMapNode, label: string): MindMapNode {
  const found = walk(tree).find((node) => node.label === label)
  if (!found) throw new Error(`no node labelled ${label}`)
  return found
}

function childLabels(node: MindMapNode): string[] {
  return node.children.map((child) => child.label)
}

/** How many blocks are in a fixture, at every level of it. */
function countBlocks(blocks: readonly MindMapSourceBlock[]): number {
  return blocks.reduce((sum, block) => sum + 1 + countBlocks(block.children ?? []), 0)
}

/** A block whose content is `[[wiki links]]` and nothing else. */
function links(id: string, type: string, targets: readonly string[]): MindMapSourceBlock {
  return {
    id,
    type,
    content: targets.map((target) => ({ type: 'wikiLink', props: { target } }))
  }
}

/**
 * Everything the map owes the user an answer about.
 *
 * Not "blocks": a wiki link is a run of inline content that becomes a node of
 * its own (#1672), so it is a candidate exactly like a block that would be a
 * node. That is the deliberate widening of the invariant below — counting
 * blocks alone would silently stop covering links the moment they exist.
 *
 * Every fixture here is built from blocks that WOULD each be a node and from
 * links with distinct targets, so this stays a count rather than a second copy
 * of the projection's rules.
 */
function countCandidates(blocks: readonly MindMapSourceBlock[]): number {
  return blocks.reduce((sum, block) => {
    const inline = Array.isArray(block.content) ? block.content : []
    const linkCount = inline.filter((run) => (run as { type?: unknown }).type === 'wikiLink').length
    const hasText = inline.some(
      (run) =>
        typeof (run as { text?: unknown }).text === 'string' &&
        (run as { text: string }).text.trim() !== ''
    )
    // A paragraph is never a node, and neither is a block with nothing to show
    // — a list item holding only links IS its links (#1672). Neither is a
    // candidate; the links inside them still are.
    const own = block.type !== 'paragraph' && hasText ? 1 : 0
    return sum + own + linkCount + countCandidates(block.children ?? [])
  }, 0)
}

/** A chain of nested bullets, one per level, labelled by the level it sits at. */
function bulletChain(depth: number, labelAt: (level: number) => string): MindMapSourceBlock {
  let block = bullet(`c-${depth}`, labelAt(depth))
  for (let level = depth - 1; level >= 1; level -= 1) {
    block = bullet(`c-${level}`, labelAt(level), [block])
  }
  return block
}

describe('buildMindMap — the depth cap', () => {
  const overDeep = bulletChain(MIND_MAP_MAX_DEPTH + 2, (level) => `Level ${level}`)

  it('folds what is past the cap into the deepest node still drawn', () => {
    const map = buildMindMap([overDeep], TRANSLATED)

    // Everything inside the cap is drawn, and nothing past it is.
    expect(map.nodes.map((node) => node.label)).toEqual([
      'Note',
      ...Array.from({ length: MIND_MAP_MAX_DEPTH }, (_, index) => `Level ${index + 1}`)
    ])
    expect(Math.max(...map.nodes.map((node) => node.depth))).toBe(MIND_MAP_MAX_DEPTH)

    // And the deepest node still drawn says how much is behind it, in the
    // caller's own words. The two folded levels are counted, not dropped.
    const deepest = labelled(map.tree, `Level ${MIND_MAP_MAX_DEPTH}`)
    expect(deepest.foldedCount).toBe(2)
    expect(deepest.detail).toBe('+2 more')
  })

  it('counts depth in nodes that are DRAWN, so a blank one costs nothing', () => {
    // The same chain, with one rung that has nothing to show. It draws no box —
    // #1671's rule — so the rung below it lands where a labelled one would, and
    // the whole chain still fits inside the cap.
    const withBlank = bulletChain(MIND_MAP_MAX_DEPTH + 1, (level) =>
      level === 3 ? '   ' : `Level ${level}`
    )
    const map = buildMindMap([withBlank], TRANSLATED)

    expect(map.nodeCount).toBe(MIND_MAP_MAX_DEPTH + 1)
    expect(labelled(map.tree, `Level ${MIND_MAP_MAX_DEPTH + 1}`).depth).toBe(MIND_MAP_MAX_DEPTH)
    // Nothing was hidden, so nothing is counted: a blank rung had nothing to
    // see, and "+1 more" would send the user looking for content that is not
    // there. An over-deep rung DID have something to show, which is the whole
    // difference between the two.
    expect(map.nodes.every((node) => node.foldedCount === 0)).toBe(true)
    expect(map.nodes.every((node) => node.detail === '')).toBe(true)
  })

  it('folds a blank heading and an over-deep heading by the very same route', () => {
    const blankHeading = buildMindMap(
      [heading('a', 1, 'Alpha'), heading('blank', 2, '   '), heading('c', 3, 'Still visible')],
      TRANSLATED
    )

    // Both cases re-parent onto the nearest node that IS drawn; they differ
    // only in whether there was anything to count.
    expect(childLabels(labelled(blankHeading.tree, 'Alpha'))).toEqual(['Still visible'])
    expect(labelled(blankHeading.tree, 'Alpha').foldedCount).toBe(0)
    expect(labelled(blankHeading.tree, 'Still visible').depth).toBe(2)
  })

  it('counts depth through a container, so a heading inside a toggle stays inside it', () => {
    // Three toggles deep, then a heading, then a list under it: the heading does
    // not hoist out of the toggle it was written in, and the depth it is at is
    // the depth the cap is applied to.
    const map = buildMindMap(
      [
        toggle('t1', 'One', [
          toggle('t2', 'Two', [
            toggle('t3', 'Three', [
              heading('h', 1, 'Inside heading'),
              bullet('b1', 'Under the heading', [bullet('b2', 'Deeper', [bullet('b3', 'Deepest')])])
            ])
          ])
        ])
      ],
      TRANSLATED
    )

    expect(labelled(map.tree, 'Inside heading').depth).toBe(4)
    expect(labelled(map.tree, 'Under the heading').depth).toBe(5)
    expect(labelled(map.tree, 'Deeper').depth).toBe(MIND_MAP_MAX_DEPTH)
    // One rung past the cap, and it folds into the node above it rather than
    // being hoisted somewhere shallower or dropped.
    expect(map.nodes.some((node) => node.label === 'Deepest')).toBe(false)
    expect(labelled(map.tree, 'Deeper').foldedCount).toBe(1)
  })
})

describe('buildMindMap — the label cap', () => {
  const long = 'A heading with rather a lot to say for itself, going on and on and on past the cap'

  it('clips an over-long label, marks the clip, and keeps the node navigable', () => {
    const map = buildMindMap([heading('h', 1, long)], TRANSLATED)
    const [, node] = map.nodes

    expect(long.length).toBeGreaterThan(MIND_MAP_MAX_LABEL_CHARS)
    expect(node.label.length).toBeLessThanOrEqual(MIND_MAP_MAX_LABEL_CHARS)
    // Visible, not silent — and recoverable, because the node still points at
    // the block that holds every word of it.
    expect(node.label.endsWith('…')).toBe(true)
    expect(long.startsWith(node.label.slice(0, -1).trimEnd())).toBe(true)
    expect(node.blockId).toBe('h')
  })

  it('leaves a label that fits exactly as the user wrote it', () => {
    const map = buildMindMap([heading('h', 1, 'Short enough')], TRANSLATED)

    expect(map.nodes[1].label).toBe('Short enough')
  })
})

describe('buildMindMap — the children cap', () => {
  const items = (count: number): MindMapSourceBlock[] =>
    Array.from({ length: count }, (_, index) => bullet(`b-${index + 1}`, `Item ${index + 1}`))

  it('draws every child of a parent that fits, with no marker at all', () => {
    const map = buildMindMap(
      [heading('h', 1, 'Section'), ...items(MIND_MAP_MAX_CHILDREN)],
      TRANSLATED
    )

    const section = labelled(map.tree, 'Section')
    expect(section.children).toHaveLength(MIND_MAP_MAX_CHILDREN)
    expect(section.children.every((child) => child.kind === 'bullet')).toBe(true)
  })

  it('stands the overflow behind one marker the user can open', () => {
    const overflow = 8
    const map = buildMindMap(
      [heading('h', 1, 'Section'), ...items(MIND_MAP_MAX_CHILDREN + overflow)],
      TRANSLATED
    )

    const section = labelled(map.tree, 'Section')
    expect(section.children).toHaveLength(MIND_MAP_MAX_CHILDREN + 1)
    // The children that are drawn are the first ones, in the order they were
    // written — the map reads top-down, like the note.
    expect(childLabels(section).slice(0, MIND_MAP_MAX_CHILDREN)).toEqual(
      items(MIND_MAP_MAX_CHILDREN).map((_, index) => `Item ${index + 1}`)
    )

    const marker = section.children[MIND_MAP_MAX_CHILDREN]
    expect(marker.kind).toBe('more')
    expect(marker.foldedCount).toBe(overflow)
    expect(marker.label).toBe(`+${overflow} more`)
    // Derived from its parent, so the same branch opens to the same shape on
    // every rebuild — that is what lets expansion be a set of ids.
    expect(marker.id).toBe(`${section.id}-more`)
    // The count is the label, never also a badge underneath it.
    expect(marker.detail).toBe('')
  })

  it('counts the whole branch behind the marker, not only its top row', () => {
    const map = buildMindMap(
      [
        heading('h', 1, 'Section'),
        ...items(MIND_MAP_MAX_CHILDREN),
        bullet('hidden', 'Hidden', [bullet('hidden-a', 'Under it'), bullet('hidden-b', 'Also')])
      ],
      TRANSLATED
    )

    // "+3 more" hiding a subtree of three is honest; "+1 more" hiding three
    // would be exactly the quiet loss this whole ticket exists to prevent.
    const marker = labelled(map.tree, '+3 more')
    expect(marker.foldedCount).toBe(3)
  })

  it('labels a marker with a number even when the caller has no translator', () => {
    const map = buildMindMap([heading('h', 1, 'Section'), ...items(MIND_MAP_MAX_CHILDREN + 2)], {
      rootLabel: 'Note'
    })

    const marker = labelled(map.tree, '+2')
    expect(marker.kind).toBe('more')
    // The wording is chrome and can be missing; the count never is.
    expect(marker.foldedCount).toBe(2)
  })
})

describe('buildMindMap — expansion', () => {
  const blocks = [
    heading('h', 1, 'Section'),
    ...Array.from({ length: MIND_MAP_MAX_CHILDREN + 5 }, (_, index) =>
      bullet(`b-${index + 1}`, `Item ${index + 1}`)
    )
  ]
  const markerId = `mm-h-more`

  it('opens the branch in place, leaving nothing folded', () => {
    const folded = buildMindMap(blocks, TRANSLATED)
    expect(labelled(folded.tree, '+5 more').id).toBe(markerId)

    const opened = buildMindMap(blocks, { ...TRANSLATED, expanded: new Set([markerId]) })

    const section = labelled(opened.tree, 'Section')
    expect(section.children).toHaveLength(MIND_MAP_MAX_CHILDREN + 5)
    expect(section.children.some((child) => child.kind === 'more')).toBe(false)
    expect(opened.nodes.every((node) => node.foldedCount === 0)).toBe(true)
    // In place: the branch opened where it was, under the same parent.
    expect(childLabels(opened.tree)).toEqual(['Section'])
  })

  it('opens an expanded branch to identical coordinates every time', () => {
    const first = buildMindMap(blocks, { ...TRANSLATED, expanded: new Set([markerId]) })
    const second = buildMindMap(structuredClone(blocks), {
      ...TRANSLATED,
      expanded: new Set([markerId])
    })

    expect(second).toEqual(first)
    expect(second.nodes.map((node) => [node.id, node.x, node.y])).toEqual(
      first.nodes.map((node) => [node.id, node.x, node.y])
    )
  })

  it('leaves every other branch exactly where it was', () => {
    const twoSections = [
      ...blocks,
      heading('h2', 1, 'Other'),
      bullet('o-1', 'Untouched'),
      bullet('o-2', 'Also untouched')
    ]
    const folded = buildMindMap(twoSections, TRANSLATED)
    const opened = buildMindMap(twoSections, { ...TRANSLATED, expanded: new Set([markerId]) })

    // Expansion is not a redraw of the whole note: what was not opened keeps
    // its shape, so the user's spatial memory of it survives the click.
    expect(childLabels(labelled(opened.tree, 'Other'))).toEqual(
      childLabels(labelled(folded.tree, 'Other'))
    )
  })

  it('ignores an expansion id that no longer matches anything', () => {
    // Ids are minted from block ids, which the note re-mints when it is edited.
    // A stale one has to be inert rather than an error — which is also why the
    // set is never persisted in the first place.
    const map = buildMindMap(blocks, { ...TRANSLATED, expanded: new Set(['mm-gone-more']) })

    expect(labelled(map.tree, '+5 more').kind).toBe('more')
  })

  it('still holds the whole-map cap after an expansion', () => {
    const huge = [
      heading('h', 1, 'Section'),
      ...Array.from({ length: MIND_MAP_MAX_NODES * 2 }, (_, index) =>
        bullet(`b-${index + 1}`, `Item ${index + 1}`)
      )
    ]

    const folded = buildMindMap(huge, TRANSLATED)
    expect(folded.reachedNodeCap).toBe(false)

    const opened = buildMindMap(huge, { ...TRANSLATED, expanded: new Set([markerId]) })

    // Opening a branch is not a way around the total: the map fills to the cap
    // and the rest folds onto the section, which says how much.
    expect(opened.nodeCount).toBe(MIND_MAP_MAX_NODES)
    expect(opened.reachedNodeCap).toBe(true)
    // Root and heading aside, every drawn node is an item; the items the budget
    // did not reach are counted on the heading rather than dropped.
    const drawnItems = opened.nodes.filter((node) => node.kind === 'bullet').length
    expect(labelled(opened.tree, 'Section').foldedCount).toBe(countBlocks(huge) - 1 - drawnItems)
  })
})

/** Wide AND deep: within every per-parent cap, far past the total. */
const sprawl: MindMapSourceBlock[] = Array.from({ length: MIND_MAP_MAX_CHILDREN }, (_, top) => [
  heading(`h1-${top}`, 1, `Section ${top + 1}`),
  ...Array.from({ length: MIND_MAP_MAX_CHILDREN }, (_, mid) => [
    heading(`h2-${top}-${mid}`, 2, `Part ${top + 1}.${mid + 1}`),
    ...Array.from({ length: MIND_MAP_MAX_CHILDREN }, (_, leaf) =>
      bullet(`b-${top}-${mid}-${leaf}`, `Item ${top + 1}.${mid + 1}.${leaf + 1}`)
    )
  ]).flat()
]).flat()

describe('buildMindMap — wiki links meet the same caps', () => {
  const targets = (count: number, from = 1): string[] =>
    Array.from({ length: count }, (_, index) => `Note ${index + from}`)

  it('folds a fan of links behind one marker, like any other children', () => {
    const overflow = 8
    const map = buildMindMap(
      [
        heading('h', 1, 'Reading'),
        links('l', 'paragraph', targets(MIND_MAP_MAX_CHILDREN + overflow))
      ],
      TRANSLATED
    )

    // A link is a node the map owes the user an answer about, so it goes
    // through the very same placement — a section packed with links folds
    // rather than sprawling past the cap.
    const section = labelled(map.tree, 'Reading')
    expect(section.children).toHaveLength(MIND_MAP_MAX_CHILDREN + 1)
    expect(
      section.children.slice(0, MIND_MAP_MAX_CHILDREN).every((c) => c.kind === 'wikiLink')
    ).toBe(true)
    const marker = section.children[MIND_MAP_MAX_CHILDREN]
    expect(marker.kind).toBe('more')
    expect(marker.foldedCount).toBe(overflow)
  })

  it('opens a folded fan of links in place', () => {
    const blocks = [
      heading('h', 1, 'Reading'),
      links('l', 'paragraph', targets(MIND_MAP_MAX_CHILDREN + 4))
    ]
    const opened = buildMindMap(blocks, { ...TRANSLATED, expanded: new Set(['mm-h-more']) })

    const section = labelled(opened.tree, 'Reading')
    expect(section.children).toHaveLength(MIND_MAP_MAX_CHILDREN + 4)
    expect(section.children.every((child) => child.kind === 'wikiLink')).toBe(true)
    expect(opened.nodes.every((node) => node.foldedCount === 0)).toBe(true)
  })

  it('folds a link written past the depth cap into the deepest node drawn', () => {
    // A chain exactly at the cap, with one rung too many below it holding both
    // text and a link.
    let deepest: MindMapSourceBlock = {
      id: 'too-deep',
      type: 'bulletListItem',
      content: [
        { type: 'text', text: 'Too deep' },
        { type: 'wikiLink', props: { target: 'Roadmap' } }
      ]
    }
    for (let level = MIND_MAP_MAX_DEPTH; level >= 1; level -= 1) {
      deepest = bullet(`d-${level}`, `Rung ${level}`, [deepest])
    }
    const map = buildMindMap([deepest], TRANSLATED)

    expect(map.nodes.some((node) => node.kind === 'wikiLink')).toBe(false)
    // The over-deep bullet AND the link inside it, both counted on the last
    // node the map drew — never dropped for being past the edge.
    expect(labelled(map.tree, `Rung ${MIND_MAP_MAX_DEPTH}`).foldedCount).toBe(2)
  })

  it('counts links written inside a branch that is already folded away', () => {
    const map = buildMindMap(
      [
        heading('h', 1, 'Reading'),
        ...Array.from({ length: MIND_MAP_MAX_CHILDREN }, (_, index) =>
          bullet(`b-${index}`, `Item ${index + 1}`)
        ),
        // One bullet past the cap, with two links written beneath it. The
        // bullet folds, and the links arrive with the scope already folded —
        // all three are behind the marker, and all three are what it says.
        {
          id: 'over',
          type: 'bulletListItem',
          content: [{ type: 'text', text: 'Spilled' }],
          children: [links('over-links', 'bulletListItem', ['Roadmap', 'Backlog'])]
        }
      ],
      TRANSLATED
    )

    expect(labelled(map.tree, '+3 more').foldedCount).toBe(3)
  })

  it('clips an over-long link label like any other label', () => {
    const map = buildMindMap(
      [links('l', 'paragraph', ['R'.repeat(MIND_MAP_MAX_LABEL_CHARS * 2)])],
      TRANSLATED
    )

    const link = map.nodes.find((node) => node.kind === 'wikiLink')!
    expect(link.label.length).toBeLessThanOrEqual(MIND_MAP_MAX_LABEL_CHARS)
    expect(link.label.endsWith('…')).toBe(true)
    // Clipped for drawing only — what it OPENS is untouched.
    expect(link.wikiTarget).toHaveLength(MIND_MAP_MAX_LABEL_CHARS * 2)
  })
})

describe('buildMindMap — the whole-map node cap', () => {
  it('stops at the cap and says that it did', () => {
    const map = buildMindMap(sprawl, TRANSLATED)

    expect(map.nodeCount).toBe(MIND_MAP_MAX_NODES)
    expect(map.reachedNodeCap).toBe(true)
  })

  it('says nothing about a cap a note never reaches', () => {
    const map = buildMindMap([heading('h', 1, 'Section'), bullet('b', 'Item')], TRANSLATED)

    expect(map.reachedNodeCap).toBe(false)
    expect(map.nodes.every((node) => node.foldedCount === 0)).toBe(true)
  })

  it('lands the overflow on nodes that ARE drawn, in the words the caller gave', () => {
    const map = buildMindMap(sprawl, TRANSLATED)

    const carrying = map.nodes.filter((node) => node.foldedCount > 0)
    expect(carrying.length).toBeGreaterThan(0)
    for (const node of carrying) {
      if (node.kind === 'more') continue
      expect(node.detail).toContain(`+${node.foldedCount} more`)
    }
  })
})

describe('buildMindMap — nothing disappears silently', () => {
  /**
   * The promise the whole ticket rests on, as one assertion.
   *
   * Every fixture below is built out of blocks that WOULD each be a node, so
   * the count of blocks is the count of things the map owes the user an answer
   * about. Each one has to be drawn exactly once, or counted exactly once on a
   * node that is drawn. Anything else is a block that vanished.
   */
  function expectNothingLost(blocks: readonly MindMapSourceBlock[]): void {
    const map = buildMindMap(blocks, TRANSLATED)

    // Every cap holds...
    expect(map.nodeCount).toBeLessThanOrEqual(MIND_MAP_MAX_NODES)
    for (const node of map.nodes) {
      expect(node.depth).toBeLessThanOrEqual(MIND_MAP_MAX_DEPTH)
      expect(node.label.length).toBeLessThanOrEqual(MIND_MAP_MAX_LABEL_CHARS)
    }
    for (const node of walk(map.tree)) {
      const markers = node.children.filter((child) => child.kind === 'more')
      // At most the cap in real children, and never more than one marker to
      // stand for whatever did not fit.
      expect(node.children.length - markers.length).toBeLessThanOrEqual(MIND_MAP_MAX_CHILDREN)
      expect(markers.length).toBeLessThanOrEqual(1)
    }

    // ...and nothing was lost keeping them. A wiki-link node counts on both
    // sides of this: it is a candidate, and it is drawn or folded like any
    // other node.
    const drawn = map.nodes.filter((node) => node.kind !== 'root' && node.kind !== 'more').length
    const counted = map.nodes.reduce((sum, node) => sum + node.foldedCount, 0)
    expect(drawn + counted).toBe(countCandidates(blocks))
  }

  const deepChain = bulletChain(MIND_MAP_MAX_DEPTH + 3, (level) => `Rung ${level}`)

  const wideSection: MindMapSourceBlock[] = [
    heading('wide', 1, 'Wide'),
    ...Array.from({ length: MIND_MAP_MAX_CHILDREN + 6 }, (_, index) =>
      bullet(`w-${index}`, `Item ${index}`, [
        bullet(`w-${index}-a`, 'Under it'),
        links(`w-${index}-l`, 'bulletListItem', [`Reaches ${index}`])
      ])
    )
  ]

  it('accounts for everything past the depth cap', () => {
    expectNothingLost([deepChain])
  })

  it('accounts for everything past the children cap, subtrees included', () => {
    expectNothingLost(wideSection)
  })

  it('accounts for everything past the whole-map cap', () => {
    expectNothingLost(sprawl)
  })

  it('accounts for wiki links, which are candidates too', () => {
    // Links past the children cap, links inside a bullet that is itself past
    // it, and a link written in a paragraph that is no node at all.
    expectNothingLost([
      heading('links', 1, 'Reading'),
      ...Array.from({ length: MIND_MAP_MAX_CHILDREN }, (_, index) =>
        links(`l-${index}`, 'bulletListItem', [`Note ${index + 1}`])
      ),
      links('over', 'bulletListItem', ['Spilled A', 'Spilled B']),
      links('prose', 'paragraph', ['From prose'])
    ])
  })

  it('accounts for everything when all four caps bite at once', () => {
    // The deep chain and the wide section come FIRST, so they are projected
    // while there is still budget: that is what puts the depth cap and the
    // children cap in force here rather than letting the node cap answer for
    // everything. The over-long heading trips the label cap on the way past.
    const blocks: MindMapSourceBlock[] = [
      deepChain,
      ...wideSection,
      heading('long', 1, 'x'.repeat(MIND_MAP_MAX_LABEL_CHARS * 2)),
      links('prose', 'paragraph', ['Reached from prose']),
      ...sprawl
    ]

    expectNothingLost(blocks)

    // Not a vacuous pass: every fold route really did fire on this note.
    const map = buildMindMap(blocks, TRANSLATED)
    expect(map.reachedNodeCap).toBe(true)
    expect(labelled(map.tree, `Rung ${MIND_MAP_MAX_DEPTH}`).foldedCount).toBeGreaterThan(0)
    expect(walk(map.tree).some((node) => node.kind === 'more')).toBe(true)
    expect(map.nodes.some((node) => node.label.endsWith('…'))).toBe(true)
    expect(map.nodes.some((node) => node.kind === 'wikiLink')).toBe(true)
  })
})
