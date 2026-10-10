import { describe, expect, it } from 'vitest'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { isObjectOfTarget } from './relation-drop'

const snapshot = {
  tags: {
    employee: { ancestors: ['person'] },
    person: { ancestors: [] }
  }
} as unknown as TagSchemaSnapshot

describe('isObjectOfTarget', () => {
  it('links a note whose header carries the target tag or a tag that extends it', () => {
    expect(isObjectOfTarget(['Person'], 'person', snapshot)).toBe(true)
    expect(isObjectOfTarget(['employee'], 'person', snapshot)).toBe(true)
  })

  it('offers to add the tag to a note without it', () => {
    expect(isObjectOfTarget(['work'], 'person', snapshot)).toBe(false)
    expect(isObjectOfTarget([], 'person', snapshot)).toBe(false)
  })
})
