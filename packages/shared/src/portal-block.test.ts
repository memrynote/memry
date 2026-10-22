import { describe, expect, it } from 'vitest'
import {
  PORTAL_SEARCH_DEFAULT_LIMIT,
  PORTAL_SEARCH_MAX_LIMIT,
  anchorSuffix,
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

describe('parsePortalDefinition', () => {
  it('reads a whole-note portal', () => {
    const parsed = parsePortalDefinition('{"note":"n1"}')
    expect(parsed).toMatchObject({
      ok: true,
      definition: { target: { kind: 'note', note: 'n1' }, hidden: [] }
    })
  })

  it('reads a block portal with hidden anchors and drops invalid ones', () => {
    const parsed = parsePortalDefinition(
      '{"note":"n1","block":"chl-7f2a","hidden":["b9x1","b9x1","NO","x"]}'
    )
    expect(parsed).toMatchObject({
      ok: true,
      definition: { target: { kind: 'block', note: 'n1', block: 'chl-7f2a' }, hidden: ['b9x1'] }
    })
  })

  it('reads a search portal and clamps the limit', () => {
    expect(parsePortalDefinition('{"search":{"text":"exam"}}')).toMatchObject({
      ok: true,
      definition: {
        target: { kind: 'search', text: 'exam', limit: PORTAL_SEARCH_DEFAULT_LIMIT }
      }
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
    expect(parsePortalDefinition('{"note":"n1","block":"NOPE"}')).toMatchObject({
      ok: false,
      reason: 'shape',
      raw: { note: 'n1' }
    })
  })

  it('names the source note, except for a search', () => {
    const note = parsePortalDefinition('{"note":"n1","block":"chl-7f2a"}')
    const search = parsePortalDefinition('{"search":{"text":"x"}}')
    if (!note.ok || !search.ok) throw new Error('fixture must parse')
    expect(portalSourceNote(note.definition.target)).toBe('n1')
    expect(portalSourceNote(search.definition.target)).toBeNull()
  })
})

describe('serializePortalDefinition', () => {
  it('writes the target first, then hidden, in two-space JSON', () => {
    const text = serializePortalDefinition({
      target: { kind: 'block', note: 'n1', block: 'chl-7f2a' },
      hidden: ['b9x1']
    })
    expect(text).toBe(
      '{\n  "note": "n1",\n  "block": "chl-7f2a",\n  "hidden": [\n    "b9x1"\n  ]\n}'
    )
  })

  it('keeps keys a newer build wrote through an edit', () => {
    const parsed = parsePortalDefinition('{"note":"n1","future":{"a":1}}')
    if (!parsed.ok) throw new Error('fixture must parse')
    const text = serializePortalDefinition(
      { target: { kind: 'note', note: 'n2' }, hidden: [] },
      parsed.raw
    )
    expect(JSON.parse(text)).toEqual({ note: 'n2', future: { a: 1 } })
  })

  it('is a fixed point: parse then serialize then parse is stable', () => {
    const source = '{"search":{"text":"exam","tag":"bio","limit":20},"hidden":["b9x1"]}'
    const first = parsePortalDefinition(source)
    if (!first.ok) throw new Error('fixture must parse')
    const text = serializePortalDefinition(first.definition, first.raw)
    const second = parsePortalDefinition(text)
    expect(second).toMatchObject({ ok: true, definition: first.definition })
    expect(serializePortalDefinition(first.definition, first.raw)).toBe(text)
  })
})
