/**
 * Property Utilities
 *
 * Shared functions for property handling across the application.
 * Used by the unified properties hook and page components.
 *
 * @module lib/property-utils
 */

/**
 * Supported property types.
 * - text: Plain text string
 * - number: Numeric value
 * - checkbox: Boolean (true/false)
 * - date: ISO date string (YYYY-MM-DD)
 * - url: Valid URL string
 */
export type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'url'
  | 'status'
  | 'select'
  | 'multiselect'

/**
 * Property value interface.
 */
export interface PropertyValue {
  name: string
  value: unknown
  type: string
}

/**
 * Infer property type from value.
 * Used when adding new properties without explicit type.
 *
 * @param value - The value to infer type from
 * @returns The inferred property type
 */
export function inferType(value: unknown): PropertyType {
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') {
    // Check for ISO date pattern
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date'
    // Check for URL pattern
    if (/^https?:\/\//.test(value)) return 'url'
  }
  return 'text'
}

/**
 * Get default value for a property type.
 * Used when creating new properties.
 *
 * @param type - The property type
 * @returns Default value for that type
 */
export function getDefaultValueForType(type: PropertyType): unknown {
  switch (type) {
    case 'checkbox':
      return false
    case 'number':
      return 0
    case 'date':
      return new Date().toISOString()
    case 'multiselect':
      return []
    case 'status':
    case 'select':
      return null
    case 'url':
      return ''
    case 'text':
    default:
      return ''
  }
}

/**
 * Map backend property type string to UI PropertyType.
 * Handles any legacy or unknown types gracefully.
 *
 * @param backendType - Type string from backend
 * @returns Mapped PropertyType
 */
export function getUniquePropertyName(baseName: string, existingNames: string[]): string {
  if (!existingNames.includes(baseName)) return baseName
  let counter = 2
  while (existingNames.includes(`${baseName} ${counter}`)) {
    counter++
  }
  return `${baseName} ${counter}`
}

export function mapPropertyType(backendType: string): PropertyType {
  const typeMap: Record<string, PropertyType> = {
    text: 'text',
    number: 'number',
    checkbox: 'checkbox',
    date: 'date',
    url: 'url',
    status: 'status',
    select: 'select',
    multiselect: 'multiselect'
  }
  return typeMap[backendType] ?? 'text'
}
