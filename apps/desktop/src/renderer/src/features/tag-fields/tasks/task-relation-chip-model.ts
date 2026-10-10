import type { ResolvedField } from '@memry/contracts/tag-schema'
import type { FieldGroup } from '../build-field-groups'

export function isRelationField(field: ResolvedField): boolean {
  return field.relation !== null || field.type === 'relation'
}

export interface TaskRelationChipModel {
  field: string
  uri: string
  noteId: string | null
}

const NOTE_URI_PREFIX = 'memry://note/'

export function firstRelationChip(groups: readonly FieldGroup[]): TaskRelationChipModel | null {
  for (const group of groups) {
    for (const { field, value } of group.slots) {
      if (!isRelationField(field)) continue
      const uri = (Array.isArray(value) ? value : [value]).find(
        (item): item is string => typeof item === 'string' && item.length > 0
      )
      if (!uri) continue
      return {
        field: field.name,
        uri,
        noteId: uri.startsWith(NOTE_URI_PREFIX) ? uri.slice(NOTE_URI_PREFIX.length) : null
      }
    }
  }
  return null
}
