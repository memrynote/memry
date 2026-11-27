import type { PropertyType } from '@memry/db-schema/schema/notes-cache'
import { parseYamlDate, spellYamlDate } from '@main/vault/yaml-dates'
import { valueFitsType } from '@main/vault/property-type'

// ============================================================================
// Activity Level
// ============================================================================

export const ACTIVITY_THRESHOLDS = {
  MINIMAL: 100,
  LIGHT: 500,
  MODERATE: 1000
} as const

export type ActivityLevel = 0 | 1 | 2 | 3 | 4

export function calculateActivityLevel(characterCount: number): ActivityLevel {
  if (characterCount === 0) return 0
  if (characterCount <= ACTIVITY_THRESHOLDS.MINIMAL) return 1
  if (characterCount <= ACTIVITY_THRESHOLDS.LIGHT) return 2
  if (characterCount <= ACTIVITY_THRESHOLDS.MODERATE) return 3
  return 4
}

// ============================================================================
// Property Serialization
// ============================================================================

export function serializeValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value instanceof Date) {
    return spellYamlDate(value)
  }
  return JSON.stringify(value)
}

export function deserializeValue(value: string | null, type: PropertyType): unknown {
  if (value === null) {
    return null
  }
  // `rating: good` under a number type stays the text it is. Coerced, it read
  // as NaN (or `yes` as false), and the next whole-record properties write
  // put that back into the file in place of the user's value.
  if (!valueFitsType(type, value)) {
    return value
  }

  switch (type) {
    case 'number':
      return Number(value)
    case 'checkbox':
      return value === 'true'
    case 'multiselect':
    case 'relation':
    case 'project': {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : [value]
      } catch {
        return [value]
      }
    }
    case 'select':
    case 'status':
    default:
      return value
  }
}

/**
 * A stored value as a frontmatter value. `serializeValue` stored a list or a
 * map as its JSON text and a date in its YAML spelling, which
 * `deserializeValue` hands back as text: written into a file as that, a list
 * became a quoted string (#5558). The text of a string that spells JSON or a
 * date reads the same, so such a string comes back as the list or the date.
 */
export function fileValueOf(value: string | null, type: PropertyType): unknown {
  const typed = deserializeValue(value, type)
  if (typeof typed !== 'string') return typed
  if (type === 'date') return parseYamlDate(typed) ?? typed
  if (!typed.startsWith('[') && !typed.startsWith('{')) return typed
  try {
    const parsed: unknown = JSON.parse(typed)
    return typeof parsed === 'object' && parsed !== null ? parsed : typed
  } catch {
    // Text that only starts like JSON is the string it is.
    return typed
  }
}

// ============================================================================
// Property Type Inference
// ============================================================================

export function inferPropertyType(value: unknown): PropertyType {
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'text'
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date'
    if (/^https?:\/\//.test(value)) return 'url'
  }
  return 'text'
}
