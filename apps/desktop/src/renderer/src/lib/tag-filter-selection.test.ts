import { describe, expect, it } from 'vitest'
import {
  andTagsInclude,
  fullTagSelection,
  sameTagSelection,
  sanitizeAndTags,
  tagKey,
  toggleAndTag
} from './tag-filter-selection'

describe('tagKey', () => {
  it('folds case and trims', () => {
    expect(tagKey('  Work ')).toBe('work')
  })
})

describe('toggleAndTag', () => {
  it('adds a tag that is not selected', () => {
    expect(toggleAndTag('work', [], 'urgent')).toEqual(['urgent'])
  })

  it('removes a tag that is selected, case-insensitively', () => {
    expect(toggleAndTag('work', ['Urgent', 'home'], 'urgent')).toEqual(['home'])
  })

  it('keeps the prior selection when a third tag is added', () => {
    expect(toggleAndTag('work', ['urgent', 'home'], 'travel')).toEqual(['urgent', 'home', 'travel'])
  })

  it('never toggles the primary tag off', () => {
    expect(toggleAndTag('work', ['urgent'], 'WORK')).toEqual(['urgent'])
  })

  it('ignores blank input', () => {
    expect(toggleAndTag('work', ['urgent'], '   ')).toEqual(['urgent'])
  })

  it('preserves the user casing of an added tag', () => {
    expect(toggleAndTag('work', [], ' Deep Work ')).toEqual(['Deep Work'])
  })
})

describe('andTagsInclude', () => {
  it('matches regardless of case', () => {
    expect(andTagsInclude(['Urgent'], 'urgent')).toBe(true)
    expect(andTagsInclude(['Urgent'], 'home')).toBe(false)
  })
})

describe('sanitizeAndTags', () => {
  it('drops blanks, the primary tag and case-duplicates, keeping click order', () => {
    expect(sanitizeAndTags('work', ['urgent', '', 'WORK', 'Urgent', 'home'])).toEqual([
      'urgent',
      'home'
    ])
  })
})

describe('fullTagSelection', () => {
  it('puts the primary tag first', () => {
    expect(fullTagSelection('Work', ['urgent'])).toEqual(['Work', 'urgent'])
  })
})

describe('sameTagSelection', () => {
  it('ignores order and case', () => {
    expect(sameTagSelection(['work', 'urgent'], ['Urgent', 'Work'])).toBe(true)
    expect(sameTagSelection(['work'], ['work', 'urgent'])).toBe(false)
  })
})
