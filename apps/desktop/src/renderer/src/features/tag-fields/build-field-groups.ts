import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'

export interface FieldSlot {
  field: ResolvedField
  /** Undefined: an empty slot drawn from the tag; nothing is in the file. */
  value: unknown
}

export interface FieldGroup {
  /** The tag that defines the group's fields. */
  tag: ResolvedTag
  /** The header tag that inherits these fields ("Person via #employee"); null for its own fields. */
  via: ResolvedTag | null
  slots: FieldSlot[]
}

export interface FieldGroups {
  groups: FieldGroup[]
  /** Values no group shows, in their stored order: the "This note" group. */
  rest: Array<{ name: string; value: unknown }>
}

/**
 * Header tags (a note) or tags (a task), in order, to their field groups:
 * each tag with fields gives its own group, then one per ancestor, nearest
 * first. Field names are vault-wide, so a name an earlier group shows is
 * skipped, and a group left with no fields is dropped.
 */
export function buildFieldGroups(
  tags: readonly string[],
  snapshot: TagSchemaSnapshot | undefined,
  values: Readonly<Record<string, unknown>>
): FieldGroups {
  const groups: FieldGroup[] = []
  const shown = new Set<string>()
  const seenTags = new Set<string>()

  const slotsOf = (fields: readonly ResolvedField[]): FieldSlot[] => {
    const slots: FieldSlot[] = []
    for (const field of fields) {
      if (shown.has(field.name)) continue
      shown.add(field.name)
      slots.push({
        field,
        value: Object.prototype.hasOwnProperty.call(values, field.name)
          ? values[field.name]
          : undefined
      })
    }
    return slots
  }

  for (const name of tags) {
    const key = name.trim().toLowerCase()
    if (seenTags.has(key)) continue
    seenTags.add(key)
    const tag = snapshot?.tags[key]
    if (!tag || !tag.hasFields) continue

    const own = slotsOf(tag.ownFields)
    if (own.length > 0) groups.push({ tag, via: null, slots: own })
    for (const inherited of tag.inherited) {
      const parent = snapshot?.tags[inherited.from]
      if (!parent) continue
      const slots = slotsOf(inherited.fields)
      if (slots.length > 0) groups.push({ tag: parent, via: tag, slots })
    }
  }

  const rest = Object.entries(values)
    .filter(([name]) => !shown.has(name))
    .map(([name, value]) => ({ name, value }))

  return { groups, rest }
}

/** A value a field group counts as filled. */
export function isFilledValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}
