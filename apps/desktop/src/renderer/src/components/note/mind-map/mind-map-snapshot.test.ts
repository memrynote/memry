/**
 * What a saved mind map actually contains.
 *
 * Everything here runs without a DOM and without the drawing library, which is
 * what makes it cheap to be exhaustive about the three things that decide
 * whether a canvas found six months from now on another device is any use: the
 * anchor its links carry, the date on its root, and whether the document is a
 * canvas at all.
 *
 * The one step this cannot cover is `convertToExcalidrawElements`, which turns
 * these descriptors into real elements — the library's barrel cannot initialize
 * under jsdom (the same reason every unit suite under `pages/canvas` mocks it).
 * The stand-in below does what the converter does that matters here: it hands
 * back elements with identity, leaving the fields this file asserts on
 * untouched.
 */

import { describe, expect, it } from 'vitest'
import { parseMemryHref, tabFromMemryHref } from '@/lib/memry-links'
import { buildMindMap } from './build-mind-map'
import { mindMapSceneJson, mintSnapshotElements, uniqueCanvasTitle } from './mind-map-snapshot'
import type { MindMapBoxElement, MindMapElement, MindMapSourceBlock } from './mind-map-types'

const GENERATED = 'Snapshot · 21 Aug 2026'

function heading(id: string, level: number, text: string): MindMapSourceBlock {
  return { id, type: 'heading', props: { level }, content: [{ type: 'text', text }] }
}

function bullet(id: string, text: string, children?: MindMapSourceBlock[]): MindMapSourceBlock {
  return { id, type: 'bulletListItem', content: [{ type: 'text', text }], children }
}

/** A paragraph carrying one `[[wiki link]]`, as the editor stores it. */
function linkPara(id: string, target: string): MindMapSourceBlock {
  return {
    id,
    type: 'paragraph',
    content: [{ type: 'wikiLink', props: { target, alias: '' } }]
  }
}

const BLOCKS: MindMapSourceBlock[] = [
  bullet('b-intro', 'Before any heading'),
  heading('b-risks', 1, 'Risks'),
  bullet('b-lock', 'Vendor lock-in', [bullet('b-deep', 'Exit costs')]),
  heading('b-cost', 2, 'Cost'),
  bullet('b-budget', 'Budget'),
  heading('b-plan', 1, 'Plan')
]

function snapshot(blocks: readonly MindMapSourceBlock[] = BLOCKS): MindMapElement[] {
  const map = buildMindMap(blocks, { rootLabel: 'Roadmap', noteId: 'n1' })
  return mintSnapshotElements(map, { noteId: 'n1', generatedLabel: GENERATED })
}

function boxes(elements: readonly MindMapElement[]): Map<string, MindMapBoxElement> {
  return new Map(
    elements
      .filter((element): element is MindMapBoxElement => element.type === 'rectangle')
      .map((box) => [box.id, box] as const)
  )
}

describe('mintSnapshotElements — links that outlive the document', () => {
  it('anchors a heading on its own text, never on a block id', () => {
    const byId = boxes(snapshot())

    expect(byId.get('mm-b-risks')?.link).toBe('memry://note/n1#Risks')
    expect(byId.get('mm-b-cost')?.link).toBe('memry://note/n1#Cost')
  })

  it('anchors a list node on its nearest ancestor heading, however deep', () => {
    const byId = boxes(snapshot())

    // Directly under `Risks`…
    expect(byId.get('mm-b-lock')?.link).toBe('memry://note/n1#Risks')
    // …and nested one level further under the same one.
    expect(byId.get('mm-b-deep')?.link).toBe('memry://note/n1#Risks')
    // Under the deeper heading, not the one that opened the section.
    expect(byId.get('mm-b-budget')?.link).toBe('memry://note/n1#Cost')
  })

  it('anchors on nothing above the first heading, and at the root', () => {
    const byId = boxes(snapshot())

    // No heading to borrow: the link opens the note at the top, which is where
    // a build with no anchors at all would have put the reader anyway.
    expect(byId.get('mm-b-intro')?.link).toBe('memry://note/n1')
    expect(byId.get('mm-root')?.link).toBe('memry://note/n1')
  })

  it('writes no block anchor anywhere in the document, whatever the note holds', () => {
    // The load-bearing assertion of the whole feature: a block id is minted at
    // parse time and markdown does not carry it, so every one of these would be
    // dead the moment the file was opened on another device.
    //
    // Deliberately over a note holding every kind that carries no block of its
    // own — a wiki link and a "+N more" fold marker — because those are exactly
    // the boxes the DRAWN map anchors on their node id, which is a block anchor
    // in every way that matters here.
    const everything = [
      ...BLOCKS,
      linkPara('b-link', 'Roadmap'),
      heading('b-many', 1, 'Many'),
      ...Array.from({ length: 13 }, (_, i) => bullet(`b-many-${i}`, `Item ${i}`))
    ]
    const map = buildMindMap(everything, { rootLabel: 'Roadmap', noteId: 'n1' })
    // Precondition: the fixture really does contain both.
    expect(map.nodes.some((node) => node.kind === 'wikiLink')).toBe(true)
    expect(map.nodes.some((node) => node.kind === 'more')).toBe(true)

    for (const box of boxes(
      mintSnapshotElements(map, { noteId: 'n1', generatedLabel: GENERATED })
    ).values()) {
      expect(box.link).not.toMatch(/#\^/)
    }
  })

  it('escapes a heading whose text would otherwise break the link', () => {
    const byId = boxes(snapshot([heading('b-q', 1, 'Q3 / Q4 plan?')]))

    const href = byId.get('mm-b-q')!.link!
    expect(href).toBe('memry://note/n1#Q3%20%2F%20Q4%20plan%3F')

    const parsed = parseMemryHref(href)
    if (parsed?.kind !== 'note') throw new Error('the link no longer names a note')
    expect(parsed.anchor).toEqual({ type: 'heading', text: 'Q3 / Q4 plan?' })
  })

  it('round-trips through the parser a canvas will read it with', () => {
    for (const box of boxes(snapshot()).values()) {
      const parsed = parseMemryHref(box.link!)
      // Still resolves to the note itself on a build that has never heard of
      // anchors: the item comes out of the path, the anchor out of the fragment.
      expect(parsed).toMatchObject({ kind: 'note', id: 'n1' })
      expect(tabFromMemryHref(box.link!)).toMatchObject({ type: 'note', path: '/note/n1' })
      if (parsed?.kind === 'note' && parsed.anchor) {
        expect(parsed.anchor.type).toBe('heading')
      }
    }
  })
})

describe('mintSnapshotElements — the document itself', () => {
  it('dates the root, under the note title', () => {
    const root = boxes(snapshot()).get('mm-root')!

    // Found months later, the canvas has to say it is a snapshot rather than a
    // live view of the note.
    expect(root.label.text).toBe(`Roadmap\n${GENERATED}`)
  })

  it('grows the root box to hold the line the layout never budgeted for', () => {
    const map = buildMindMap([heading('b-a', 1, 'A')], { rootLabel: 'Q3', noteId: 'n1' })
    const drawnRoot = map.elements.find((element) => element.id === 'mm-root')!
    const savedRoot = boxes(
      mintSnapshotElements(map, { noteId: 'n1', generatedLabel: GENERATED })
    ).get('mm-root')!

    expect(savedRoot.height).toBeGreaterThan(drawnRoot.type === 'rectangle' ? drawnRoot.height : 0)
    // Downwards only: the root is alone in its column, and every other box has
    // to stay exactly where the drawn map put it.
    expect(savedRoot.x).toBe(map.nodes[0].x)
    expect(savedRoot.y).toBe(map.nodes[0].y)
  })

  it('leaves every other node exactly where the drawn map put it', () => {
    const map = buildMindMap(BLOCKS, { rootLabel: 'Roadmap', noteId: 'n1' })
    const drawn = boxes(map.elements)
    const saved = boxes(mintSnapshotElements(map, { noteId: 'n1', generatedLabel: GENERATED }))

    for (const [id, box] of saved) {
      if (id === 'mm-root') continue
      const before = drawn.get(id)!
      // Same map, re-minted for a file — not a second projection of the note.
      expect([box.x, box.y, box.width, box.height]).toEqual([
        before.x,
        before.y,
        before.width,
        before.height
      ])
    }
  })

  it('mints plain shapes carrying links, never live entity cards', () => {
    for (const element of snapshot()) {
      // `customData.entityType` is what makes a rectangle a live Memry card
      // (see `pages/canvas/canvas-cards.ts`). A card is roughly ten times the
      // size of a map node, and a dozen make the map unreadable.
      expect(element).not.toHaveProperty('customData')
      expect(['rectangle', 'arrow', 'line']).toContain(element.type)
    }
  })

  it('keeps its connectors bound so a dragged node takes them with it', () => {
    const arrows = snapshot().filter((element) => element.type === 'arrow')
    const boxIds = new Set(boxes(snapshot()).keys())

    expect(arrows.length).toBeGreaterThan(0)
    for (const arrow of arrows) {
      expect(boxIds.has(arrow.start.id)).toBe(true)
      expect(boxIds.has(arrow.end.id)).toBe(true)
    }
  })
})

describe('mindMapSceneJson', () => {
  /** Stands in for the converter, which only adds identity to each element. */
  const converted = (elements: readonly MindMapElement[]): unknown[] =>
    elements.map((element, index) => ({ ...element, id: `minted-${index}`, version: 1 }))

  it('produces a document the vault stores as a canvas, unchanged', () => {
    const json = mindMapSceneJson(converted(snapshot()))
    const scene = JSON.parse(json) as Record<string, unknown>

    // These keys, in this order, are `canvas/scene-file.ts`'s own — what
    // `canonicalize` writes back out. Matching it means the store canonicalizes
    // this document to itself plus its `memry` sidecar, and writes it as-is.
    expect(Object.keys(scene)).toEqual([
      'type',
      'version',
      'source',
      'elements',
      'appState',
      'files'
    ])
    expect(scene.type).toBe('excalidraw')
    expect(scene.version).toBe(2)
    expect(scene.source).toBe('memry')
    expect(scene.appState).toEqual({})
    expect(scene.files).toEqual({})
    expect(Array.isArray(scene.elements)).toBe(true)
    expect(scene.elements).toHaveLength(snapshot().length)
  })

  it('reads back as the editor loads a scene', () => {
    // `canvas-editor.tsx` does exactly this on mount.
    const parsed = JSON.parse(mindMapSceneJson(converted(snapshot()))) as {
      elements?: unknown[]
      appState?: unknown
      files?: unknown
    }
    expect(parsed.elements?.length).toBeGreaterThan(0)
    expect(parsed.appState).toBeDefined()
    expect(parsed.files).toBeDefined()
  })

  it('survives a map with nothing in it', () => {
    const empty = buildMindMap([], { rootLabel: 'Empty', noteId: 'n1' })
    const scene = JSON.parse(
      mindMapSceneJson(
        converted(mintSnapshotElements(empty, { noteId: 'n1', generatedLabel: GENERATED }))
      )
    ) as { elements: unknown[] }

    // The root alone, still a valid document.
    expect(scene.elements).toHaveLength(1)
  })
})

describe('uniqueCanvasTitle', () => {
  it('keeps the note title when nothing at the root has it', () => {
    expect(uniqueCanvasTitle('Roadmap', ['Sketches', null, ''])).toBe('Roadmap')
  })

  it('suffixes from 2 upwards, exactly as the vault names the file', () => {
    expect(uniqueCanvasTitle('Roadmap', ['Roadmap'])).toBe('Roadmap 2')
    expect(uniqueCanvasTitle('Roadmap', ['Roadmap', 'Roadmap 2'])).toBe('Roadmap 3')
    // A gap is not filled: the next free number wins, so two saves in a row
    // never race onto the same name.
    expect(uniqueCanvasTitle('Roadmap', ['Roadmap', 'Roadmap 3'])).toBe('Roadmap 2')
  })

  it('collides the way the filesystem does — case-folded and NFC-normalized', () => {
    // macOS and Windows are case-insensitive, and macOS stores filenames
    // decomposed, so a comparison that missed either would hand two rows the
    // same label while their files differ.
    expect(uniqueCanvasTitle('Roadmap', ['ROADMAP'])).toBe('Roadmap 2')
    expect(uniqueCanvasTitle('Café', ['Café'])).toBe('Café 2')
  })

  it('ignores canvases with no title of their own', () => {
    expect(uniqueCanvasTitle('Roadmap', [null, null])).toBe('Roadmap')
  })
})

describe('mintSnapshotElements — a heading longer than the label cap', () => {
  // 96 characters: comfortably past MIND_MAP_MAX_LABEL_CHARS (72), so the box
  // label is clipped and the anchor must not be.
  const LONG =
    'Everything we learned about vendor lock-in during the third quarter of the migration work'

  const map = buildMindMap([heading('b-long', 1, LONG), bullet('b-kid', 'A detail')], {
    rootLabel: 'Roadmap',
    noteId: 'n1'
  })
  const byId = boxes(mintSnapshotElements(map, { noteId: 'n1', generatedLabel: GENERATED }))

  it('clips the drawn label, because a box cannot hold it', () => {
    // Precondition: if the cap ever stops biting here, the assertions below
    // stop proving anything, so it is asserted rather than assumed.
    expect(byId.get('mm-b-long')!.label.text.length).toBeLessThan(LONG.length)
    expect(byId.get('mm-b-long')!.label.text).toMatch(/…$/)
  })

  it('anchors on the WHOLE heading, not on the clipped label', () => {
    // The single failure this field exists to prevent: an anchor clipped to
    // `Everything we learned about vendor lock-in during the thir…` matches no
    // heading on the device that opens the canvas, so the link silently lands
    // at the top of the note instead of at the section.
    const href = `memry://note/n1#${encodeURIComponent(LONG)}`
    expect(byId.get('mm-b-long')!.link).toBe(href)
    // And the child borrows the same whole text.
    expect(byId.get('mm-b-kid')!.link).toBe(href)

    const parsed = parseMemryHref(byId.get('mm-b-long')!.link!)
    if (parsed?.kind !== 'note') throw new Error('the link no longer names a note')
    expect(parsed.anchor).toEqual({ type: 'heading', text: LONG })
  })
})

describe('mintSnapshotElements — wiki-link nodes', () => {
  const blocks = [heading('b-h', 1, 'Risks'), linkPara('b-p', 'Roadmap')]

  function linkBox(wikiHrefs?: ReadonlyMap<string, string>): MindMapBoxElement {
    const map = buildMindMap(blocks, { rootLabel: 'Q3', noteId: 'n1' })
    const node = map.nodes.find((n) => n.kind === 'wikiLink')!
    return boxes(
      mintSnapshotElements(map, { noteId: 'n1', generatedLabel: GENERATED, wikiHrefs })
    ).get(node.id)!
  }

  it('carries the resolved target when the caller could resolve it', () => {
    const map = buildMindMap(blocks, { rootLabel: 'Q3', noteId: 'n1' })
    const node = map.nodes.find((n) => n.kind === 'wikiLink')!
    const box = linkBox(new Map([[node.id, 'memry://note/n2#Plan']]))

    // The point of a saved wiki-link node: it opens the note it names, on any
    // device, rather than a node id only this session understood.
    expect(box.link).toBe('memry://note/n2#Plan')
  })

  it('falls back to the heading it is written under when it resolves to nothing', () => {
    // Never a dead box and never an invented destination: it opens the source
    // note at the section the link is written in.
    expect(linkBox().link).toBe('memry://note/n1#Risks')
  })

  it('never carries the node-id anchor the drawn map gives it', () => {
    const map = buildMindMap(blocks, { rootLabel: 'Q3', noteId: 'n1' })
    const node = map.nodes.find((n) => n.kind === 'wikiLink')!
    const drawn = boxes(map.elements).get(node.id)!

    // On screen the href is only a click handle, and it IS a node-id anchor.
    expect(drawn.link).toBe(`memry://note/n1#^${node.id}`)
    // In a file that names a block this device never minted.
    expect(linkBox().link).not.toMatch(/#\^/)
  })

  it('keeps the dashed outline that tells it apart from this note', () => {
    expect(linkBox().strokeStyle).toBe('dashed')
  })
})

describe('mintSnapshotElements — fold markers', () => {
  // Thirteen children under one heading: one past MIND_MAP_MAX_CHILDREN, so the
  // twelfth slot becomes a "+N more".
  const map = buildMindMap(
    [
      heading('b-h', 1, 'Risks'),
      ...Array.from({ length: 13 }, (_, i) => bullet(`b-${i}`, `Item ${i}`))
    ],
    { rootLabel: 'Q3', noteId: 'n1', formatMore: (count) => `+${count} more` }
  )
  const marker = map.nodes.find((node) => node.kind === 'more')!
  const box = boxes(mintSnapshotElements(map, { noteId: 'n1', generatedLabel: GENERATED })).get(
    marker.id
  )!

  it('is minted rather than dropped, so the canvas says how much is missing', () => {
    // Dropping it would be exactly the silent loss the feature refuses: the
    // canvas would simply be short two rows with nothing to say so.
    expect(marker.foldedCount).toBeGreaterThan(0)
    expect(box.label.text).toBe(`+${marker.foldedCount} more`)
  })

  it('opens the note at the section the missing rows actually live in', () => {
    // It cannot expand in a file — there is nothing on the other side to expand
    // it — so it points at the place the folded content really is.
    expect(box.link).toBe('memry://note/n1#Risks')
    expect(box.link).not.toMatch(/#\^/)
  })
})

describe("mintSnapshotElements — the date never displaces the root's own badge", () => {
  it('keeps what the root already had to say, alongside the generation date', () => {
    // A table before the first heading is counted on the root, so the root has
    // a badge line of its own — the same line a fold count would land on.
    const map = buildMindMap([{ id: 'b-t', type: 'table' }, heading('b-h', 1, 'Risks')], {
      rootLabel: 'Q3',
      noteId: 'n1',
      formatContentCount: (kind, count) => `${count} ${kind}`
    })
    const rootDetail = map.nodes[0].detail
    // Precondition: if the root stops carrying a badge, this proves nothing.
    if (rootDetail === '') throw new Error('the root carries no badge; fixture is wrong')

    const box = boxes(mintSnapshotElements(map, { noteId: 'n1', generatedLabel: GENERATED })).get(
      'mm-root'
    )!
    const [title, badges] = box.label.text.split('\n')
    expect(title).toBe('Q3')
    // The date is added AHEAD of that line, never instead of it: replacing it
    // would drop whatever the root was saying about what is not on the picture
    // — a fold count above all.
    expect(badges).toBe(`${GENERATED} · ${rootDetail}`)
  })
})
