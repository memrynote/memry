import { describe, expect, it } from 'vitest'
import {
  parseViewBlockDefinition,
  serializeViewBlockDefinition,
  updateViewBlockDefinition,
  viewBlockScope
} from './view-block'

describe('parseViewBlockDefinition', () => {
  it('reads a tag source with a layout and filters', () => {
    const parsed = parseViewBlockDefinition(
      JSON.stringify({
        source: { kind: 'tag', tag: 'inbox-thought' },
        layout: 'table',
        filters: { and: ['created after "2026-01-05"', { not: 'title isEmpty' }] },
        order: [{ property: 'created', direction: 'desc' }],
        limit: 10
      })
    )

    expect(parsed).toMatchObject({
      ok: true,
      definition: {
        source: { kind: 'tag', tag: 'inbox-thought' },
        layout: 'table',
        filters: { and: ['created after "2026-01-05"', { not: 'title isEmpty' }] },
        order: [{ property: 'created', direction: 'desc' }],
        limit: 10
      }
    })
  })

  it('tells an empty block, broken JSON and a missing source apart', () => {
    expect(parseViewBlockDefinition('  \n')).toEqual({ ok: false, reason: 'empty' })
    expect(parseViewBlockDefinition('{"source":')).toEqual({ ok: false, reason: 'json' })
    expect(parseViewBlockDefinition('[1]')).toEqual({ ok: false, reason: 'shape' })
    expect(parseViewBlockDefinition('{"source":{"kind":"tag","tag":""}}')).toMatchObject({
      ok: false,
      reason: 'shape'
    })
  })

  it('ignores known keys it cannot use instead of failing the block', () => {
    // #given values a newer build might write
    const parsed = parseViewBlockDefinition(
      JSON.stringify({
        source: { kind: 'vault' },
        layout: 'kanban',
        filters: { xor: [] },
        limit: -1,
        order: [{ property: 'title', direction: 'sideways' }]
      })
    )

    // #then the block still renders, from the source alone
    expect(parsed).toMatchObject({ ok: true, definition: { source: { kind: 'vault' } } })
    if (parsed.ok) {
      expect(parsed.definition).toEqual({ source: { kind: 'vault' } })
    }
  })

  it('keeps unknown keys for the next rewrite', () => {
    const parsed = parseViewBlockDefinition(
      JSON.stringify({ source: { kind: 'vault' }, groupBy: 'folder', layout: 'kanban' })
    )
    if (!parsed.ok) throw new Error('expected a definition')

    const next = updateViewBlockDefinition(parsed.raw, { limit: 5 })

    expect(JSON.parse(next)).toEqual({
      source: { kind: 'vault' },
      groupBy: 'folder',
      layout: 'kanban',
      limit: 5
    })
  })
})

describe('serializeViewBlockDefinition', () => {
  it('writes source first, two-space JSON, and drops undefined keys', () => {
    const text = serializeViewBlockDefinition({
      layout: 'list',
      view: undefined,
      source: { kind: 'folder', path: 'Projects' }
    })

    expect(text).toBe(
      '{\n  "source": {\n    "kind": "folder",\n    "path": "Projects"\n  },\n  "layout": "list"\n}'
    )
    expect(parseViewBlockDefinition(text)).toMatchObject({ ok: true })
  })

  it('removes a key patched to undefined', () => {
    const next = updateViewBlockDefinition(
      { source: { kind: 'vault' }, view: 'Recent' },
      { view: undefined }
    )
    expect(JSON.parse(next)).toEqual({ source: { kind: 'vault' } })
  })
})

describe('viewBlockScope', () => {
  it('reads the whole vault through the root folder', () => {
    expect(viewBlockScope({ kind: 'vault' })).toEqual({ kind: 'folder', path: '' })
    expect(viewBlockScope({ kind: 'tag', tag: 'a' })).toEqual({ kind: 'tag', tag: 'a' })
  })
})
