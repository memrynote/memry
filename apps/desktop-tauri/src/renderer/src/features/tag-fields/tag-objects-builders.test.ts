import { describe, expect, it } from 'vitest'
import type { PresetKey, ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { PresetOffer, TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { buildCreateOptions } from './mention-create-options'
import { objectInitials } from './object-avatar'
import { quickFields, quickFieldValues } from './quick-fields-card'

function field(name: string, type: ResolvedField['type'], many?: boolean): ResolvedField {
  return {
    name,
    type,
    relation:
      type === 'relation' ? { target: 'company', many: many ?? false, inverse: null } : null,
    definedBy: 'person'
  }
}

function tag(key: string, preset: PresetKey | null, hasFields = true): ResolvedTag {
  return {
    name: key,
    key,
    color: 'sky',
    icon: null,
    editable: true,
    ownFields: [],
    inherited: [],
    effectiveFields: [],
    hasFields,
    extends: null,
    ancestors: [],
    template: null,
    preset,
    ownPreset: preset
  }
}

function offer(key: PresetKey, state: PresetOffer['state']): PresetOffer {
  return {
    key,
    name: key,
    icon: `icon:${key}`,
    color: 'sky',
    fields: [],
    templateSections: [],
    state,
    existingTag: null,
    alsoAdds: []
  }
}

function snapshot(tags: ResolvedTag[], presets: PresetOffer[] = []): TagSchemaSnapshot {
  return {
    tags: Object.fromEntries(tags.map((t) => [t.key, t])),
    objects: {},
    presets,
    presetStripDismissed: false
  }
}

describe('buildCreateOptions (D2 "Create … as")', () => {
  it('puts the last used tag first, then ready-made tags in catalogue order, then the rest', () => {
    const options = buildCreateOptions(
      snapshot([
        tag('client', null),
        tag('book', 'book'),
        tag('person', 'person'),
        tag('company', 'company')
      ]),
      'book'
    )
    expect(options.map((o) => (o.kind === 'tag' ? o.tag : o.kind))).toEqual([
      'book',
      'person',
      'company',
      'client',
      'plain'
    ])
    expect(options[0]).toMatchObject({ kind: 'tag', lastUsed: true })
  })

  it('offers ready-made tags not added yet and never offers plain tags', () => {
    const options = buildCreateOptions(
      snapshot(
        [tag('person', 'person'), tag('label', null, false)],
        [offer('person', 'added'), offer('meeting', 'add'), offer('book', 'add-fields')]
      ),
      null
    )
    expect(options).toEqual([
      { kind: 'tag', tag: 'person', name: 'person', lastUsed: false },
      {
        kind: 'preset',
        preset: 'meeting',
        name: 'meeting',
        icon: 'icon:meeting',
        color: 'sky'
      },
      { kind: 'preset', preset: 'book', name: 'book', icon: 'icon:book', color: 'sky' },
      { kind: 'plain' }
    ])
  })

  it('keeps Plain note when no tag has fields', () => {
    expect(buildCreateOptions(undefined, null)).toEqual([{ kind: 'plain' }])
  })
})

describe('quick fields (D2 panel 2)', () => {
  it('offers the first two fields the card can edit', () => {
    const fields = [
      field('Company', 'relation'),
      field('Met on', 'date'),
      field('Role', 'text'),
      field('Email', 'text')
    ]
    expect(quickFields(fields).map((f) => f.name)).toEqual(['Company', 'Role'])
  })

  it('writes only typed values, and one relation value when the field takes one', () => {
    const fields = [field('Company', 'relation'), field('Role', 'text'), field('Age', 'number')]
    expect(
      quickFieldValues(fields, {
        Company: ['memry://note/a', 'memry://note/b'],
        Role: '  ',
        Age: '41'
      })
    ).toEqual({ Company: ['memry://note/b'], Age: 41 })
    expect(quickFieldValues(fields, {})).toEqual({})
  })
})

describe('objectInitials', () => {
  it.each([
    ['Ahmet Yılmaz', 'AY'],
    ['Can Öztürk', 'CÖ'],
    ['selin', 'S'],
    ['Mary Jane Watson', 'MW'],
    ['  ', '']
  ])('%s → %s', (title, initials) => {
    expect(objectInitials(title)).toBe(initials)
  })
})
