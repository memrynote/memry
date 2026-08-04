import { describe, it, expect } from 'vitest'
import { readProjectNames, withProjectName, withoutProjectName } from './project-property'

describe('readProjectNames', () => {
  it('wraps a bare string into a single-name list', () => {
    expect(readProjectNames({ project: 'Alpha' })).toEqual(['Alpha'])
  })

  it('treats null as no names', () => {
    expect(readProjectNames({ project: null })).toEqual([])
  })

  it('treats an empty string as no names', () => {
    expect(readProjectNames({ project: '' })).toEqual([])
  })

  it('drops a non-string scalar such as a number', () => {
    expect(readProjectNames({ project: 42 })).toEqual([])
  })

  it('drops nested array entries instead of throwing', () => {
    expect(readProjectNames({ project: [['Alpha'], 'Beta'] })).toEqual(['Beta'])
  })

  it('drops blank and whitespace-only entries', () => {
    expect(readProjectNames({ project: ['Alpha', '', '   ', 'Beta'] })).toEqual(['Alpha', 'Beta'])
  })

  it('trims surrounding whitespace from entries', () => {
    expect(readProjectNames({ project: ['  Alpha  '] })).toEqual(['Alpha'])
  })

  it('dedupes case-variant duplicates, keeping the first occurrence', () => {
    expect(readProjectNames({ project: ['Alpha', 'alpha', 'ALPHA', 'Beta'] })).toEqual([
      'Alpha',
      'Beta'
    ])
  })

  it('returns an empty list when the key is missing', () => {
    expect(readProjectNames({})).toEqual([])
  })
})

describe('withProjectName', () => {
  it('appends the name when absent', () => {
    expect(withProjectName(['Alpha'], 'Beta')).toEqual(['Alpha', 'Beta'])
  })

  it('is a no-op when the name is already present in a different casing', () => {
    expect(withProjectName(['Alpha'], 'alpha')).toEqual(['Alpha'])
  })
})

describe('withoutProjectName', () => {
  it('removes a case-insensitive match', () => {
    expect(withoutProjectName(['Alpha', 'Beta'], 'alpha')).toEqual(['Beta'])
  })

  it('leaves the remaining names in their original order', () => {
    expect(withoutProjectName(['Alpha', 'Beta', 'Gamma'], 'Beta')).toEqual(['Alpha', 'Gamma'])
  })
})
