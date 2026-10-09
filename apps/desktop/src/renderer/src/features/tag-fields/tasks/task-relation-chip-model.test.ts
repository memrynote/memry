import { describe, expect, it } from 'vitest'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { FieldGroup } from '../build-field-groups'
import { firstRelationChip } from './task-relation-chip-model'

const field = (name: string, type: ResolvedField['type']): ResolvedField => ({
  name,
  type,
  relation: type === 'relation' ? { target: 'person', many: false, inverse: null } : null,
  definedBy: 'delegated'
})
const tag = { key: 'delegated', name: 'delegated', color: '#c00' } as ResolvedTag
const group = (slots: FieldGroup['slots']): FieldGroup => ({ tag, via: null, slots })

describe('firstRelationChip', () => {
  it('skips empty relations and non-relation fields, taking the first filled one', () => {
    const groups = [
      group([
        { field: field('Follow up', 'date'), value: '2026-05-14' },
        { field: field('Reviewer', 'relation'), value: [] }
      ]),
      group([
        { field: field('Waiting on', 'relation'), value: ['memry://note/n1', 'memry://note/n2'] }
      ])
    ]
    expect(firstRelationChip(groups)).toEqual({
      field: 'Waiting on',
      uri: 'memry://note/n1',
      noteId: 'n1'
    })
  })

  it('returns null when no relation is filled', () => {
    expect(
      firstRelationChip([group([{ field: field('Waiting on', 'relation'), value: undefined }])])
    ).toBeNull()
  })
})
