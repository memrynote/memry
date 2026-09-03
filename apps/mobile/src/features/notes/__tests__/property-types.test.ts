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

  it('leaves every non-string rule alone', () => {
    expect(inferPropertyType('shipped', true)).toBe('checkbox')
    expect(inferPropertyType('effort', 3)).toBe('number')
    expect(inferPropertyType('areas', ['a', 'b'])).toBe('multiselect')
    expect(inferPropertyType('project', ['Alpha'])).toBe('project')
    expect(inferPropertyType('owner', 'Kaan')).toBe('text')
  })
})

describe('the property type registry', () => {
  it('offers exactly the six addable types, in board order', () => {
    expect(addablePropertyTypes).toEqual(['text', 'number', 'date', 'checkbox', 'url', 'status'])
  })

  it('keeps project and multiselect renderable but not addable', () => {
    expect(propertyTypes.project.addable).toBe(false)
    expect(propertyTypes.multiselect.addable).toBe(false)
  })

  it('gives a new status property a value that still infers as a status', () => {
    const empty = propertyTypes.status.emptyValue
    expect(inferPropertyType('stage', empty)).toBe('status')
  })
})
