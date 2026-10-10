import { describe, expect, it } from 'vitest'
import { objectGroupLabel, presetPlural, tagDisplayName } from './tag-display-name'

const names = () => ({ name: 'Person', plural: 'People' })

describe('tagDisplayName', () => {
  it('capitalises the first letter only', () => {
    expect(tagDisplayName('person')).toBe('Person')
    expect(tagDisplayName('company/client')).toBe('Company/client')
  })
})

describe('objectGroupLabel', () => {
  it('reads a ready-made tag under its ready-made name as the plural', () => {
    expect(objectGroupLabel({ name: 'person', ownPreset: 'person' }, names)).toBe('People')
  })

  it('reads a renamed ready-made tag and a custom tag as their own name', () => {
    expect(objectGroupLabel({ name: 'contact', ownPreset: 'person' }, names)).toBe('Contact')
    expect(objectGroupLabel({ name: 'employee', ownPreset: null }, names)).toBe('Employee')
  })
})

describe('presetPlural', () => {
  it('is null for a renamed ready-made tag, so callers fall back to counting objects', () => {
    expect(presetPlural({ name: 'person', ownPreset: 'person' }, names)).toBe('People')
    expect(presetPlural({ name: 'contact', ownPreset: 'person' }, names)).toBeNull()
  })
})
