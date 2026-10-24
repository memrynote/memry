import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'

export interface FieldSlot {
  field: ResolvedField
  value: unknown
}

export interface FieldGroup {
  tag: ResolvedTag
  via: ResolvedTag | null
  slots: FieldSlot[]
}

export interface FieldGroups {
  groups: FieldGroup[]
  rest: Array<{ name: string; value: unknown }>
}

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

export function isFilledValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}
