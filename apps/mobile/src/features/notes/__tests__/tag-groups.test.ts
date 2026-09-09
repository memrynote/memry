import { describe, expect, it } from 'vitest'

import { groupTagsByCategory, tagLabelInGroup } from '../tag-groups'

describe('groupTagsByCategory', () => {
  it('keeps tags without a category in one leading group', () => {
    expect(groupTagsByCategory(['idea', 'reading'])).toEqual([
      { category: null, tags: ['idea', 'reading'] }
    ])
  })

  it('collects a path under its first segment', () => {
    expect(groupTagsByCategory(['work/clients/acme', 'work/hiring'])).toEqual([
      { category: 'work', tags: ['work/clients/acme', 'work/hiring'] }
    ])
  })

  it('puts a tag that IS a category inside that category', () => {
    expect(groupTagsByCategory(['idea', 'work', 'work/hiring'])).toEqual([
      { category: null, tags: ['idea'] },
      { category: 'work', tags: ['work', 'work/hiring'] }
    ])
  })

  it('matches category casing case-insensitively, first seen wins', () => {
    expect(groupTagsByCategory(['Work/hiring', 'work/clients'])).toEqual([
      { category: 'Work', tags: ['Work/hiring', 'work/clients'] }
    ])
  })

  it('sorts categories alphabetically after the loose group', () => {
    expect(groupTagsByCategory(['zeta/one', 'alpha/one', 'loose']).map((g) => g.category)).toEqual([
      null,
      'alpha',
      'zeta'
    ])
  })

  it('treats a leading slash as no category', () => {
    expect(groupTagsByCategory(['/odd'])).toEqual([{ category: null, tags: ['/odd'] }])
  })
})

describe('tagLabelInGroup', () => {
  it('strips the category the header already shows', () => {
    expect(tagLabelInGroup('work/clients/acme', 'work')).toBe('clients/acme')
  })

  it('strips it regardless of casing', () => {
    expect(tagLabelInGroup('work/clients', 'Work')).toBe('clients')
  })

  it('keeps the whole name for the category tag itself', () => {
    expect(tagLabelInGroup('work', 'work')).toBe('work')
  })

  it('keeps the whole name outside any category', () => {
    expect(tagLabelInGroup('idea', null)).toBe('idea')
  })
})
