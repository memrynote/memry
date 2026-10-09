import { describe, it, expect } from 'vitest'
import type { PropertyType } from '@memry/contracts/property-types'
import { inferPropertyType, resolvePropertyType } from './property-type'

describe('inferPropertyType', () => {
  it('inferPropertyType detects common property types', () => {
    expect(inferPropertyType('done', true)).toBe('checkbox')
    expect(inferPropertyType('score', 4)).toBe('number')
    expect(inferPropertyType('count', 10)).toBe('number')
    // Arrays are no longer supported, fallback to text
    expect(inferPropertyType('labels', ['a', 'b'])).toBe('text')
    expect(inferPropertyType('published', '2026-01-15')).toBe('date')
    expect(inferPropertyType('site', 'https://example.com')).toBe('url')
    expect(inferPropertyType('title', 'Hello')).toBe('text')
    expect(inferPropertyType('misc', { value: 1 })).toBe('text')
  })

  it('infers relation for an all-URI array', () => {
    expect(inferPropertyType('father', ['memry://note/nte_1'])).toBe('relation')
    expect(inferPropertyType('attendees', ['memry://task/tsk_1', 'memry://event/evt_2'])).toBe(
      'relation'
    )
  })

  it('leaves non-relation arrays as text', () => {
    expect(inferPropertyType('tags', [])).toBe('text')
    expect(inferPropertyType('tags', ['a', 'b'])).toBe('text')
    expect(inferPropertyType('mixed', ['memry://note/nte_1', 'plain'])).toBe('text')
    expect(inferPropertyType('bad', ['memry://project/prj_1'])).toBe('text')
  })

  it('does not treat a bare URI string as relation', () => {
    expect(inferPropertyType('father', 'memry://note/nte_1')).toBe('text')
  })
})

describe('resolvePropertyType — the shared precedence ladder', () => {
  const infer = (name: string, value: unknown): PropertyType => inferPropertyType(name, value)

  it('lets the reserved project name beat a stale stored definition', () => {
    // A vault imported from Obsidian can carry { name: 'project', type: 'text' }.
    expect(resolvePropertyType('project', ['Website Redesign'], 'text', infer)).toBe('project')
  })

  it('lets a memry:// URI array beat a stored definition that says text', () => {
    // This is the rule that keeps a UI-created relation from being pinned to
    // `text` by its own empty first write. Without it the array is later
    // deserialized as a raw JSON string and round-tripped into the vault file.
    expect(resolvePropertyType('father', ['memry://note/nte_1'], 'text', infer)).toBe('relation')
  })

  it('falls back to the stored definition when neither rule applies', () => {
    expect(resolvePropertyType('stage', 'Draft', 'select', infer)).toBe('select')
  })

  it('infers only when there is no stored definition', () => {
    expect(resolvePropertyType('count', 3, undefined, infer)).toBe('number')
  })

  it('does not mistake a plain string array for a relation', () => {
    expect(resolvePropertyType('tags', ['a', 'b'], undefined, infer)).toBe('text')
  })

  it('does not treat an empty array as a relation', () => {
    // The empty default a freshly-added relation starts life with. It types as
    // text here, which is exactly why the structural rule above has to override
    // the stored definition once a real value arrives.
    expect(resolvePropertyType('father', [], undefined, infer)).toBe('text')
  })
})
