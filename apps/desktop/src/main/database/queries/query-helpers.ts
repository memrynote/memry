import type { PropertyType } from '@memry/db-schema/schema/notes-cache'

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
  return JSON.stringify(value)
}

export function deserializeValue(value: string | null, type: PropertyType): unknown {
  if (value === null) {
    return null
  }

  switch (type) {
    case 'number':
      return Number(value)
    case 'checkbox':
      return value === 'true'
    default:
      return value
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
