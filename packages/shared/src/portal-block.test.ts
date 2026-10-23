import { describe, expect, it } from 'vitest'
import {
  PORTAL_SEARCH_DEFAULT_LIMIT,
  PORTAL_SEARCH_MAX_LIMIT,
  addRoot,
  anchorSuffix,
  collapse,
  expandAll,
  hideChild,
  includeParent,
  hideBlock,
  unhideBlock,
  unhideAll,
  noteCreatedChild,
  noteCreatedRootSibling,
  removeRoot,
  showChild,
  type PortalDefinition,
  type PortalTarget,
  extractAnchor,
  isAnchor,
  makeAnchor,
  parsePortalDefinition,
  portalSourceNote,
  serializePortalDefinition,
  stripAnchor
} from './portal-block'

describe('portal anchors', () => {
  it('reads an anchor that ends a block', () => {
    expect(extractAnchor('Chloroplast ^chl-7f2a')).toBe('chl-7f2a')
    expect(extractAnchor('Chloroplast ^chl-7f2a  ')).toBe('chl-7f2a')
    expect(extractAnchor('^abc123')).toBe('abc123')
  })

  it('does not read a caret that is not a trailing anchor', () => {
    expect(extractAnchor('x^2 + y')).toBeNull()
    expect(extractAnchor('e^abc123')).toBeNull()
    expect(extractAnchor('^abc123 and more')).toBeNull()
    expect(extractAnchor('short ^ab')).toBeNull()
    expect(extractAnchor('Upper ^ABC123')).toBeNull()
  })

  it('strips what it extracts and leaves other text alone', () => {
    expect(stripAnchor('Chloroplast ^chl-7f2a')).toBe('Chloroplast')
    expect(stripAnchor('Chloroplast')).toBe('Chloroplast')
  })

  it('round-trips through the suffix it writes', () => {
    const anchor = makeAnchor(() => 0.5)
    expect(isAnchor(anchor)).toBe(true)
    expect(extractAnchor(`text${anchorSuffix(anchor)}`)).toBe(anchor)
  })

  it('mints six characters from the allowed alphabet', () => {
    const anchor = makeAnchor()
    expect(anchor).toMatch(/^[a-z0-9]{6}$/)
  })
})

const def = (target: PortalTarget, raw: Record<string, unknown> = {}): PortalDefinition => ({
  v: 1,
  target,
  raw
})
const blocksDef = (
  blocks: string[],
  open: Extract<PortalTarget, { kind: 'blocks' }>['open'] = {}
): PortalDefinition => def({ kind: 'blocks', note: 'n1', blocks, open })
const targetOf = (d: PortalDefinition | null): PortalTarget => {
  if (!d) throw new Error('expected a definition')
  return d.target
}

describe('parsePortalDefinition', () => {
  it('reads a whole-note portal, with or without v', () => {
    for (const text of ['{"note":"n1"}', '{"v":1,"note":"n1"}']) {
      expect(parsePortalDefinition(text)).toMatchObject({
        ok: true,
        definition: { v: 1, target: { kind: 'note', note: 'n1', hide: [] } }
      })
    }
  })

  it('treats empty or unreadable blocks as a whole-note portal', () => {
    expect(parsePortalDefinition('{"note":"n1","blocks":[]}')).toMatchObject({
      definition: { target: { kind: 'note' } }
    })
    expect(parsePortalDefinition('{"note":"n1","blocks":["NO"]}')).toMatchObject({
      definition: { target: { kind: 'note' } }
    })
  })

  it('reads roots and open entries, dropping invalid anchors and duplicates', () => {
    const parsed = parsePortalDefinition(
      JSON.stringify({
        v: 1,
        note: 'n1',
        blocks: ['k3x9a2', 'p8m2qa', 'k3x9a2', 'x'],
        open: {
          k3x9a2: { show: ['n4c8x1', 'BAD', 'n4c8x1'] },
          p8m2qa: { hide: [] },
          zzzz99: 'nope',
          bad: { show: [] }
        }
      })
    )
    expect(parsed).toMatchObject({
      ok: true,
      definition: {
        target: {
          kind: 'blocks',
          note: 'n1',
          blocks: ['k3x9a2', 'p8m2qa'],
          open: {
            k3x9a2: { mode: 'show', ids: ['n4c8x1'] },
            p8m2qa: { mode: 'hide', ids: [] }
          }
        }
      }
    })
  })

  it('reads a search portal and clamps the limit', () => {
    expect(parsePortalDefinition('{"search":{"text":"exam"}}')).toMatchObject({
      ok: true,
      definition: { target: { kind: 'search', text: 'exam', limit: PORTAL_SEARCH_DEFAULT_LIMIT } }
    })
    expect(parsePortalDefinition('{"search":{"tag":"bio","limit":99999}}')).toMatchObject({
      ok: true,
      definition: { target: { kind: 'search', tag: 'bio', limit: PORTAL_SEARCH_MAX_LIMIT } }
    })
  })

  it('reports why it cannot read a definition', () => {
    expect(parsePortalDefinition('  ')).toEqual({ ok: false, reason: 'empty' })
    expect(parsePortalDefinition('{nope')).toEqual({ ok: false, reason: 'json' })
    expect(parsePortalDefinition('[]')).toEqual({ ok: false, reason: 'shape' })
    expect(parsePortalDefinition('{"search":{}}')).toMatchObject({ ok: false, reason: 'shape' })
    expect(parsePortalDefinition('{"blocks":["k3x9a2"]}')).toMatchObject({
      ok: false,
      reason: 'shape',
      raw: { blocks: ['k3x9a2'] }
    })
  })

  it('names the source note, except for a search', () => {
    const note = parsePortalDefinition('{"note":"n1","blocks":["k3x9a2"]}')
    const search = parsePortalDefinition('{"search":{"text":"x"}}')
    if (!note.ok || !search.ok) throw new Error('fixture must parse')
    expect(portalSourceNote(note.definition.target)).toBe('n1')
    expect(portalSourceNote(search.definition.target)).toBeNull()
  })
})

describe('serializePortalDefinition', () => {
  it('writes v, note, blocks, open in two-space JSON', () => {
    const text = serializePortalDefinition(
      blocksDef(['k3x9a2'], { k3x9a2: { mode: 'show', ids: ['n4c8x1'] } })
    )
    expect(text).toBe(
      JSON.stringify(
        { v: 1, note: 'n1', blocks: ['k3x9a2'], open: { k3x9a2: { show: ['n4c8x1'] } } },
        null,
        2
      )
    )
    expect(Object.keys(JSON.parse(text))).toEqual(['v', 'note', 'blocks', 'open'])
  })

  it('omits blocks for a note and open when nothing is open', () => {
    expect(
      JSON.parse(serializePortalDefinition(def({ kind: 'note', note: 'n1', hide: [] })))
    ).toEqual({
      v: 1,
      note: 'n1'
    })
    expect(JSON.parse(serializePortalDefinition(blocksDef(['k3x9a2'])))).toEqual({
      v: 1,
      note: 'n1',
      blocks: ['k3x9a2']
    })
  })

  it('keeps keys a newer build wrote through an edit', () => {
    const parsed = parsePortalDefinition('{"note":"n1","future":{"a":1}}')
    if (!parsed.ok) throw new Error('fixture must parse')
    const edited = {
      ...parsed.definition,
      target: { kind: 'note', note: 'n2', hide: [] } as PortalTarget
    }
    expect(JSON.parse(serializePortalDefinition(edited))).toEqual({
      v: 1,
      note: 'n2',
      future: { a: 1 }
    })
  })

  it('is a fixed point: parse then serialize then parse is stable', () => {
    const source =
      '{"v":1,"note":"n1","blocks":["k3x9a2"],"open":{"k3x9a2":{"hide":["n4c8x1"]}},"x":1}'
    const first = parsePortalDefinition(source)
    if (!first.ok) throw new Error('fixture must parse')
    const text = serializePortalDefinition(first.definition)
    const second = parsePortalDefinition(text)
    if (!second.ok) throw new Error('must reparse')
    expect(second.definition.target).toEqual(first.definition.target)
    expect(serializePortalDefinition(second.definition)).toBe(text)
  })

  it('serializes a search portal', () => {
    const text = serializePortalDefinition(
      def({ kind: 'search', text: 'exam', tag: 'bio', limit: 20 })
    )
    expect(JSON.parse(text)).toEqual({ v: 1, search: { text: 'exam', tag: 'bio', limit: 20 } })
  })
})

describe('portal edits', () => {
  it('addRoot appends, inserts after an anchor, and ignores a repeat', () => {
    const d = blocksDef(['aaaa11', 'bbbb22'])
    expect(targetOf(addRoot(d, 'cccc33'))).toMatchObject({ blocks: ['aaaa11', 'bbbb22', 'cccc33'] })
    expect(targetOf(addRoot(d, 'cccc33', 'aaaa11'))).toMatchObject({
      blocks: ['aaaa11', 'cccc33', 'bbbb22']
    })
    expect(addRoot(d, 'aaaa11')).toEqual(d)
    expect(targetOf(d)).toMatchObject({ blocks: ['aaaa11', 'bbbb22'] })
  })

  it('removeRoot refuses the only root and removes otherwise', () => {
    expect(removeRoot(blocksDef(['aaaa11']), 'aaaa11')).toBeNull()
    expect(targetOf(removeRoot(blocksDef(['aaaa11', 'bbbb22']), 'aaaa11'))).toMatchObject({
      blocks: ['bbbb22']
    })
  })

  it('includeParent replaces the roots with the parent and shows the previous roots', () => {
    const d = blocksDef(['child1', 'child2'], { child1: { mode: 'hide', ids: [] } })
    expect(targetOf(includeParent(d, 'parent'))).toEqual({
      kind: 'blocks',
      note: 'n1',
      blocks: ['parent'],
      open: {
        child1: { mode: 'hide', ids: [] },
        parent: { mode: 'show', ids: ['child1', 'child2'] }
      }
    })
  })

  it('expandAll and collapse toggle the open entry', () => {
    const open = expandAll(blocksDef(['aaaa11']), 'aaaa11')
    expect(targetOf(open)).toMatchObject({ open: { aaaa11: { mode: 'hide', ids: [] } } })
    expect(targetOf(collapse(open, 'aaaa11'))).toMatchObject({ open: {} })
  })

  it('showChild opens a collapsed parent in show-mode, appends, or un-hides', () => {
    const d = blocksDef(['aaaa11'])
    const shown = showChild(d, 'aaaa11', 'ch0001')
    expect(targetOf(shown)).toMatchObject({ open: { aaaa11: { mode: 'show', ids: ['ch0001'] } } })
    expect(targetOf(showChild(shown, 'aaaa11', 'ch0002'))).toMatchObject({
      open: { aaaa11: { mode: 'show', ids: ['ch0001', 'ch0002'] } }
    })
    expect(showChild(shown, 'aaaa11', 'ch0001')).toEqual(shown)
    const hidden = blocksDef(['aaaa11'], { aaaa11: { mode: 'hide', ids: ['ch0001', 'ch0002'] } })
    expect(targetOf(showChild(hidden, 'aaaa11', 'ch0001'))).toMatchObject({
      open: { aaaa11: { mode: 'hide', ids: ['ch0002'] } }
    })
  })

  it('hideChild removes from show-mode, adds to hide-mode, no-ops when collapsed', () => {
    const show = blocksDef(['aaaa11'], { aaaa11: { mode: 'show', ids: ['ch0001', 'ch0002'] } })
    expect(targetOf(hideChild(show, 'aaaa11', 'ch0001'))).toMatchObject({
      open: { aaaa11: { mode: 'show', ids: ['ch0002'] } }
    })
    const hide = expandAll(blocksDef(['aaaa11']), 'aaaa11')
    expect(targetOf(hideChild(hide, 'aaaa11', 'ch0001'))).toMatchObject({
      open: { aaaa11: { mode: 'hide', ids: ['ch0001'] } }
    })
    expect(hideChild(blocksDef(['aaaa11']), 'aaaa11', 'ch0001')).toEqual(blocksDef(['aaaa11']))
  })

  it('noteCreatedChild: collapsed -> show, show -> append, hide -> unchanged', () => {
    expect(targetOf(noteCreatedChild(blocksDef(['aaaa11']), 'aaaa11', 'new001'))).toMatchObject({
      open: { aaaa11: { mode: 'show', ids: ['new001'] } }
    })
    const show = blocksDef(['aaaa11'], { aaaa11: { mode: 'show', ids: ['ch0001'] } })
    expect(targetOf(noteCreatedChild(show, 'aaaa11', 'new001'))).toMatchObject({
      open: { aaaa11: { mode: 'show', ids: ['ch0001', 'new001'] } }
    })
    const hide = expandAll(blocksDef(['aaaa11']), 'aaaa11')
    expect(noteCreatedChild(hide, 'aaaa11', 'new001')).toEqual(hide)
  })

  it('noteCreatedRootSibling inserts the new root right after its sibling', () => {
    expect(
      targetOf(noteCreatedRootSibling(blocksDef(['aaaa11', 'bbbb22']), 'aaaa11', 'new001'))
    ).toMatchObject({ blocks: ['aaaa11', 'new001', 'bbbb22'] })
  })

  it('leaves note and search definitions alone', () => {
    const note = def({ kind: 'note', note: 'n1', hide: [] })
    expect(addRoot(note, 'aaaa11')).toBe(note)
    expect(expandAll(note, 'aaaa11')).toBe(note)
    expect(removeRoot(note, 'aaaa11')).toBe(note)
  })
})

describe('whole-note deny list', () => {
  const noteDef = (hide: string[] = []): PortalDefinition => def({ kind: 'note', note: 'n1', hide })

  it('reads hide, dropping non-anchors and duplicates', () => {
    const parsed = parsePortalDefinition(
      '{"v":1,"note":"n1","hide":["k3x9a2","NO",7,"k3x9a2","p8m2qa"]}'
    )
    expect(parsed).toMatchObject({
      ok: true,
      definition: { target: { kind: 'note', hide: ['k3x9a2', 'p8m2qa'] } }
    })
  })

  it('writes v, note, hide and omits an empty hide', () => {
    const text = serializePortalDefinition(noteDef(['k3x9a2']))
    expect(Object.keys(JSON.parse(text))).toEqual(['v', 'note', 'hide'])
    expect(text).toBe('{\n  "v": 1,\n  "note": "n1",\n  "hide": [\n    "k3x9a2"\n  ]\n}')
    expect(JSON.parse(serializePortalDefinition(noteDef()))).toEqual({ v: 1, note: 'n1' })
  })

  it('keeps unknown keys through a hide edit', () => {
    const parsed = parsePortalDefinition('{"note":"n1","future":1}')
    if (!parsed.ok) throw new Error('fixture must parse')
    const edited = hideBlock(parsed.definition, 'k3x9a2')
    expect(JSON.parse(serializePortalDefinition(edited))).toEqual({
      v: 1,
      note: 'n1',
      hide: ['k3x9a2'],
      future: 1
    })
  })

  it('hideBlock appends once, unhideBlock removes, unhideAll clears', () => {
    const hidden = hideBlock(hideBlock(noteDef(), 'k3x9a2'), 'p8m2qa')
    expect(targetOf(hidden)).toMatchObject({ hide: ['k3x9a2', 'p8m2qa'] })
    expect(hideBlock(hidden, 'k3x9a2')).toBe(hidden)
    expect(targetOf(unhideBlock(hidden, 'k3x9a2'))).toMatchObject({ hide: ['p8m2qa'] })
    expect(targetOf(unhideAll(hidden))).toMatchObject({ hide: [] })
  })

  it('leaves blocks and search targets alone', () => {
    const blocks = blocksDef(['k3x9a2'])
    expect(hideBlock(blocks, 'p8m2qa')).toBe(blocks)
    expect(unhideBlock(blocks, 'p8m2qa')).toBe(blocks)
    expect(unhideAll(blocks)).toBe(blocks)
  })
})
