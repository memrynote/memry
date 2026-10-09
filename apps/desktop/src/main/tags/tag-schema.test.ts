import { describe, expect, it } from 'vitest'
import type { TagSchemaStored } from '@memry/contracts/tag-schema'
import {
  applySchemaEdit,
  canonicalFieldName,
  descendantsOf,
  parseSchemaColumn,
  primaryObjectTag,
  resolveTagSchemas,
  type PropertyTypeLookup,
  type TagDefinitionInput
} from './tag-schema'

const noTypes: PropertyTypeLookup = { get: () => undefined }

function defs(
  entries: Record<string, Omit<TagSchemaStored, 't'> | null | string>
): Map<string, TagDefinitionInput> {
  return new Map(
    Object.entries(entries).map(([name, schema]) => [
      name,
      {
        name,
        color: 'blue',
        icon: null,
        schema: parseSchemaColumn(
          schema === null
            ? null
            : typeof schema === 'string'
              ? schema
              : JSON.stringify({ t: 1, ...schema })
        )
      }
    ])
  )
}

const fieldNames = (fields: Array<{ name: string }>): string[] => fields.map((f) => f.name)

describe('resolveTagSchemas', () => {
  it('inherits nearest first, orders effective fields root-first, and lets a closer name win', () => {
    const resolved = resolveTagSchemas(
      defs({
        person: { fields: [{ name: 'Role' }, { name: 'Email' }], preset: 'person' },
        employee: {
          extends: 'person',
          fields: [{ name: 'Team' }, { name: 'Email' }],
          template: { id: 'tpl_e', autofill: true }
        },
        engineer: { extends: 'Employee', fields: [{ name: 'Stack' }] }
      }),
      { get: (name) => (name === 'Role' ? { type: 'select', options: [] } : undefined) }
    )
    const engineer = resolved.get('engineer')!
    expect(engineer.ancestors).toEqual(['employee', 'person'])
    expect(engineer.inherited.map((g) => [g.from, fieldNames(g.fields)])).toEqual([
      ['employee', ['Team', 'Email']],
      ['person', ['Role']]
    ])
    expect(fieldNames(engineer.effectiveFields)).toEqual(['Role', 'Team', 'Email', 'Stack'])
    expect(engineer.effectiveFields[0]).toMatchObject({ type: 'select', definedBy: 'person' })
    expect(engineer.template).toEqual({ id: 'tpl_e', autofill: true, inheritedFrom: 'employee' })
    expect(engineer.preset).toBe('person')
    expect(engineer.ownPreset).toBeNull()
    expect(descendantsOf('person', resolved).sort()).toEqual(['employee', 'engineer'])
  })

  it('cuts an extends cycle so A and B each see the other once', () => {
    const resolved = resolveTagSchemas(
      defs({ a: { extends: 'b', fields: [{ name: 'X' }] }, b: { extends: 'a', fields: [] } }),
      noTypes
    )
    expect(resolved.get('a')!.ancestors).toEqual(['b'])
    expect(resolved.get('b')!.ancestors).toEqual(['a'])
    expect(fieldNames(resolved.get('b')!.effectiveFields)).toEqual(['X'])
  })

  it('stops at a missing parent, types relations, skips reserved names, and leaves plain tags out', () => {
    const resolved = resolveTagSchemas(
      defs({
        meeting: {
          extends: 'gone',
          fields: [
            { name: 'Attendees', relation: { target: 'Person', many: true } },
            { name: 'tags' }
          ]
        },
        plain: null
      }),
      noTypes
    )
    const meeting = resolved.get('meeting')!
    expect(meeting.extends).toBe('gone')
    expect(meeting.ancestors).toEqual([])
    expect(meeting.effectiveFields).toEqual([
      {
        name: 'Attendees',
        type: 'relation',
        relation: { target: 'person', many: true, inverse: null },
        definedBy: 'meeting'
      }
    ])
    expect(resolved.has('plain')).toBe(false)
  })

  it('marks a schema a newer build wrote as read-only', () => {
    const resolved = resolveTagSchemas(defs({ future: '{"t":4,"fields":"v2-shape"}' }), noTypes)
    expect(resolved.get('future')).toMatchObject({ editable: false, hasFields: false })
  })
})

describe('primaryObjectTag', () => {
  it('picks the first header tag that has fields, own or inherited', () => {
    const resolved = resolveTagSchemas(
      defs({ person: { fields: [{ name: 'Role' }] }, employee: { extends: 'person' }, idea: {} }),
      noTypes
    )
    expect(primaryObjectTag(['idea', 'Employee', 'person'], resolved)).toBe('employee')
    expect(primaryObjectTag(['idea', 'untracked'], resolved)).toBeNull()
  })
})

describe('applySchemaEdit', () => {
  const resolved = resolveTagSchemas(
    defs({
      person: { fields: [{ name: 'Role' }] },
      employee: { extends: 'person', fields: [{ name: 'Team' }] }
    }),
    noTypes
  )
  const employee: TagSchemaStored = {
    t: 5,
    extends: 'person',
    fields: [{ name: 'Team' }],
    future: 1
  }
  const ctx = { tag: 'employee', resolved }

  it('stamps t + 1 on a change and keeps keys a newer build added', () => {
    const result = applySchemaEdit(
      employee,
      { kind: 'add-field', field: { name: 'Desk', relation: null } },
      ctx
    )
    expect(result).toEqual({
      ok: true,
      changed: true,
      next: { t: 6, extends: 'person', fields: [{ name: 'Team' }, { name: 'Desk' }], future: 1 }
    })
  })

  it('reports a no-op edit as unchanged without a stamp', () => {
    expect(applySchemaEdit(employee, { kind: 'set-extends', parent: 'Person' }, ctx)).toEqual({
      ok: true,
      changed: false,
      next: employee
    })
    expect(
      applySchemaEdit(null, { kind: 'set-template', template: null }, { tag: 'idea', resolved })
    ).toMatchObject({
      ok: true,
      changed: false
    })
  })

  it('creates the first schema at t = 1', () => {
    const result = applySchemaEdit(
      null,
      { kind: 'add-field', field: { name: 'Role', relation: null } },
      { tag: 'idea', resolved }
    )
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      next: { t: 1, fields: [{ name: 'Role' }] }
    })
  })

  it.each([
    [
      { kind: 'add-field', field: { name: 'Tags', relation: null } },
      { code: 'reserved-name', name: 'Tags' }
    ],
    [
      { kind: 'add-field', field: { name: 'team', relation: null } },
      { code: 'duplicate-field', name: 'team', definedBy: 'employee' }
    ],
    [
      { kind: 'add-field', field: { name: 'ROLE', relation: null } },
      { code: 'duplicate-field', name: 'ROLE', definedBy: 'person' }
    ],
    [
      { kind: 'remove-field', name: 'Role' },
      { code: 'inherited-field', name: 'Role', definedBy: 'person' }
    ],
    [
      { kind: 'set-relation', name: 'Nope', relation: null },
      { code: 'unknown-field', name: 'Nope' }
    ],
    [
      { kind: 'rename-field', from: 'Team', to: 'coverZoom' },
      { code: 'reserved-name', name: 'coverZoom' }
    ]
  ] as const)('refuses %o', (edit, error) => {
    expect(applySchemaEdit(employee, edit, ctx)).toEqual({ ok: false, error })
  })

  it('refuses a parent that would close a cycle', () => {
    const person: TagSchemaStored = { t: 1, fields: [{ name: 'Role' }] }
    expect(
      applySchemaEdit(
        person,
        { kind: 'set-extends', parent: 'employee' },
        { tag: 'person', resolved }
      )
    ).toEqual({
      ok: false,
      error: { code: 'cycle', parent: 'employee' }
    })
  })

  it('refuses to edit a schema it cannot read', () => {
    const unreadable = resolveTagSchemas(defs({ future: '{"t":4,"fields":7}' }), noTypes)
    expect(
      applySchemaEdit(
        null,
        { kind: 'set-template', template: null },
        { tag: 'future', resolved: unreadable }
      )
    ).toEqual({
      ok: false,
      error: { code: 'unreadable-schema' }
    })
  })

  it('renames a field in place, and drops the old entry when a resumed rename already added the new name', () => {
    expect(
      applySchemaEdit(employee, { kind: 'rename-field', from: 'Team', to: 'Squad' }, ctx)
    ).toMatchObject({
      next: { t: 6, fields: [{ name: 'Squad' }] }
    })
    const both: TagSchemaStored = { t: 2, fields: [{ name: 'Team' }, { name: 'Squad' }] }
    expect(
      applySchemaEdit(both, { kind: 'rename-field', from: 'Team', to: 'Squad' }, ctx)
    ).toMatchObject({
      next: { t: 3, fields: [{ name: 'Squad' }] }
    })
    expect(
      applySchemaEdit(employee, { kind: 'rename-field', from: 'Absent', to: 'X' }, ctx)
    ).toMatchObject({
      changed: false
    })
  })

  it('merges a preset by appending only missing fields and keeping the own template and preset', () => {
    const own: TagSchemaStored = {
      t: 3,
      fields: [{ name: 'email' }],
      template: { id: 'mine' },
      preset: null
    }
    const result = applySchemaEdit(
      own,
      {
        kind: 'merge-preset',
        fields: [
          { name: 'Email', relation: null },
          { name: 'Company', relation: { target: 'company', many: false, inverse: 'People' } }
        ],
        template: { id: 'tpl_preset', autofill: true },
        preset: 'person'
      },
      { tag: 'contact', resolved }
    )
    expect(result).toMatchObject({
      changed: true,
      next: {
        t: 4,
        fields: [{ name: 'email' }, { name: 'Company', relation: { target: 'company' } }],
        template: { id: 'mine' },
        preset: 'person'
      }
    })
  })

  it('rewrites extends and relation targets that name a renamed or deleted tag', () => {
    const meeting: TagSchemaStored = {
      t: 2,
      extends: 'Person',
      fields: [
        { name: 'With', relation: { target: 'person', many: true, extra: 1 } },
        { name: 'At', relation: { target: 'company', many: false } }
      ]
    }
    expect(
      applySchemaEdit(meeting, { kind: 'rewrite-reference', from: 'person', to: 'Contact' }, ctx)
    ).toEqual({
      ok: true,
      changed: true,
      next: {
        t: 3,
        extends: 'contact',
        fields: [
          { name: 'With', relation: { target: 'contact', many: true, extra: 1 } },
          { name: 'At', relation: { target: 'company', many: false } }
        ]
      }
    })
    expect(
      applySchemaEdit(meeting, { kind: 'rewrite-reference', from: 'company', to: null }, ctx)
    ).toMatchObject({
      next: { t: 3, fields: [{ name: 'With' }, { name: 'At', relation: { target: null } }] }
    })
    expect(
      applySchemaEdit(meeting, { kind: 'rewrite-reference', from: 'book', to: 'reading' }, ctx)
    ).toMatchObject({
      changed: false,
      next: meeting
    })
  })
})

describe('canonicalFieldName', () => {
  it('reuses an existing spelling that differs only by case', () => {
    expect(canonicalFieldName(' email ', ['Phone', 'Email'])).toEqual({
      name: 'Email',
      reused: true
    })
    expect(canonicalFieldName('Website', ['Phone'])).toEqual({ name: 'Website', reused: false })
  })
})
