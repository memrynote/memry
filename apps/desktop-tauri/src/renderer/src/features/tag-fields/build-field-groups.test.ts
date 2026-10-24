import { describe, expect, it } from 'vitest'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { buildFieldGroups } from './build-field-groups'

function field(name: string, definedBy: string): ResolvedField {
  return { name, type: 'text', relation: null, definedBy }
}

function tag(
  key: string,
  own: string[],
  inherited: Array<{ from: string; fields: string[] }> = []
): ResolvedTag {
  const ownFields = own.map((name) => field(name, key))
  const inheritedFields = inherited.map((group) => ({
    from: group.from,
    fields: group.fields.map((name) => field(name, group.from))
  }))
  return {
    name: key[0].toUpperCase() + key.slice(1),
    key,
    color: 'sky',
    icon: null,
    editable: true,
    ownFields,
    inherited: inheritedFields,
    effectiveFields: [...inheritedFields.flatMap((group) => group.fields), ...ownFields],
    hasFields: ownFields.length + inheritedFields.length > 0,
    extends: inherited[0]?.from ?? null,
    ancestors: inherited.map((group) => group.from),
    template: null,
    preset: null,
    ownPreset: null
  }
}

function snapshot(...tags: ResolvedTag[]): TagSchemaSnapshot {
  return {
    tags: Object.fromEntries(tags.map((t) => [t.key, t])),
    objects: {},
    presets: [],
    presetStripDismissed: false
  }
}

const person = tag('person', ['Company', 'Role', 'Email', 'Phone'])
const employee = tag(
  'employee',
  ['Team', 'Start date'],
  [{ from: 'person', fields: ['Company', 'Role', 'Email', 'Phone'] }]
)
const client = tag('client', ['Status', 'Role'])
const plain = tag('later', [])

describe('buildFieldGroups', () => {
  it('draws empty slots from the tag and keeps other values under the note', () => {
    const result = buildFieldGroups(['person', 'later'], snapshot(person, plain), {
      Role: 'CTO',
      'Met on': '2026-03-14'
    })

    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].tag.key).toBe('person')
    expect(result.groups[0].slots.map((slot) => [slot.field.name, slot.value])).toEqual([
      ['Company', undefined],
      ['Role', 'CTO'],
      ['Email', undefined],
      ['Phone', undefined]
    ])
    expect(result.rest).toEqual([{ name: 'Met on', value: '2026-03-14' }])
  })

  it('shows a child tag group first, then inherited groups labelled via the child', () => {
    const result = buildFieldGroups(['Employee'], snapshot(person, employee), {})

    expect(result.groups.map((group) => [group.tag.key, group.via?.key ?? null])).toEqual([
      ['employee', null],
      ['person', 'employee']
    ])
  })

  it('shows a vault-wide field name once, in the first group that lists it', () => {
    const result = buildFieldGroups(
      ['person', 'client', 'employee'],
      snapshot(person, client, employee),
      {
        Role: 'Engineer'
      }
    )

    expect(result.groups.map((group) => group.tag.key)).toEqual(['person', 'client', 'employee'])
    expect(result.groups[1].slots.map((slot) => slot.field.name)).toEqual(['Status'])
    expect(
      result.groups.flatMap((group) => group.slots).filter((s) => s.field.name === 'Role')
    ).toHaveLength(1)
  })

  it('keeps every value as the note’s own when no header tag has fields', () => {
    const result = buildFieldGroups(['later', 'unknown'], snapshot(plain), { Role: 'CTO' })

    expect(result.groups).toEqual([])
    expect(result.rest).toEqual([{ name: 'Role', value: 'CTO' }])
  })
})
