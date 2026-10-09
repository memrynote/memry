import { describe, expect, it } from 'vitest'
import type { ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { findPropertyByName, isExtendsCandidateDisabled, templatePreview } from './settings-logic'

function tag(key: string, ancestors: string[]): ResolvedTag {
  return {
    name: key,
    key,
    color: 'sky',
    icon: null,
    editable: true,
    ownFields: [],
    inherited: [],
    effectiveFields: [],
    hasFields: true,
    extends: ancestors[0] ?? null,
    ancestors,
    template: null,
    preset: null,
    ownPreset: null
  }
}

const snapshot: TagSchemaSnapshot = {
  tags: {
    person: tag('person', []),
    employee: tag('employee', ['person']),
    contractor: tag('contractor', ['employee', 'person'])
  },
  objects: {},
  presets: [],
  presetStripDismissed: false
}

describe('isExtendsCandidateDisabled', () => {
  it('blocks the tag itself and every descendant, allows the rest', () => {
    expect(isExtendsCandidateDisabled(snapshot, 'person', 'person')).toBe(true)
    expect(isExtendsCandidateDisabled(snapshot, 'person', 'employee')).toBe(true)
    expect(isExtendsCandidateDisabled(snapshot, 'Person', 'contractor')).toBe(true)
    expect(isExtendsCandidateDisabled(snapshot, 'contractor', 'person')).toBe(false)
    expect(isExtendsCandidateDisabled(snapshot, 'employee', 'contractor')).toBe(true)
  })
})

describe('findPropertyByName', () => {
  const properties = [{ name: 'Status' }, { name: 'status' }, { name: 'Favorite' }]

  it('prefers the exact name, then an existing casing', () => {
    expect(findPropertyByName('status', properties)?.name).toBe('status')
    expect(findPropertyByName(' favorite ', properties)?.name).toBe('Favorite')
    expect(findPropertyByName('Fav', properties)).toBeNull()
    expect(findPropertyByName('  ', properties)).toBeNull()
  })
})

describe('templatePreview', () => {
  it('lists each heading with the first line under it', () => {
    expect(
      templatePreview('Intro\n## Context\n\nHow we met\nmore\n## Notes\n\n### Next\n- one')
    ).toEqual([
      { heading: 'Context', hint: 'How we met' },
      { heading: 'Notes', hint: null },
      { heading: 'Next', hint: '- one' }
    ])
  })
})
