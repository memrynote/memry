import { describe, expect, it } from 'vitest'

import { inferPropertyType } from '../note-ops'
import { addablePropertyTypes, propertyTypes } from '../property-types'

describe('inferPropertyType', () => {
  it('reads the four default status values as a status', () => {
    for (const value of ['Not started', 'In Progress', 'Done', 'Abandoned']) {
      expect(inferPropertyType('stage', value)).toBe('status')
    }
  })

  it('does not swallow the date and url strings it is ordered in front of', () => {
    expect(inferPropertyType('due', '2026-09-04')).toBe('date')
    expect(inferPropertyType('due', '2026-09-04T10:00:00Z')).toBe('date')
    expect(inferPropertyType('source', 'https://memry.app')).toBe('url')
  })

  it('takes the vault definition over anything the value shape suggests', () => {
    // The whole point of replicating definitions: `Work` is a select option,
    // not the word Work in a text field.
    expect(inferPropertyType('area', 'Work', 'select')).toBe('select')
    expect(inferPropertyType('deadline', '2027-01-11', 'text')).toBe('text')
    expect(inferPropertyType('shipped', true, 'checkbox')).toBe('checkbox')
  })

  it('keeps project reserved even against a definition that says otherwise', () => {
    expect(inferPropertyType('project', ['Alpha'], 'multiselect')).toBe('project')
  })

  it('reads a relation off its self-describing URI', () => {
    expect(inferPropertyType('blocks', 'memry://note/abc')).toBe('relation')
  })

  it('leaves every non-string rule alone', () => {
    expect(inferPropertyType('shipped', true)).toBe('checkbox')
    expect(inferPropertyType('effort', 3)).toBe('number')
    expect(inferPropertyType('areas', ['a', 'b'])).toBe('multiselect')
    expect(inferPropertyType('project', ['Alpha'])).toBe('project')
    expect(inferPropertyType('owner', 'Kaan')).toBe('text')
  })
})

describe('the property type registry', () => {
  it('offers every addable type, in board order', () => {
    expect(addablePropertyTypes).toEqual([
      'text',
      'number',
      'date',
      'checkbox',
      'url',
      'status',
      'select',
      'multiselect'
    ])
  })

  it('keeps project and relation renderable but not addable', () => {
    // Neither can be authored from a bare name — a project chip resolves
    // against real projects, a relation against a `memry://` URI.
    expect(propertyTypes.project.addable).toBe(false)
    expect(propertyTypes.relation.addable).toBe(false)
  })

  it('covers every type the renderer can be handed', () => {
    // The renderer indexes this table by type with no fallback, so a type in
    // the union and not here is a crash, not a missing icon.
    expect(Object.keys(propertyTypes).sort()).toEqual(
      [
        'checkbox',
        'date',
        'multiselect',
        'number',
        'project',
        'relation',
        'select',
        'status',
        'text',
        'url'
      ].sort()
    )
  })

  it('gives a new status property a value that still infers as a status', () => {
    const empty = propertyTypes.status.emptyValue
    expect(inferPropertyType('stage', empty)).toBe('status')
  })
})
