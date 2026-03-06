import { AlignLeft, Hash, Calendar, CheckSquare, Link, type LucideIcon } from 'lucide-react'

/**
 * Supported property types.
 * Matches the persisted note property types in shared contracts.
 */
export type PropertyType = 'text' | 'number' | 'date' | 'checkbox' | 'url'

export interface Property {
  id: string
  name: string
  type: PropertyType
  value: unknown
  isCustom: boolean
  isRequired?: boolean
}

export interface PropertyTemplate {
  id: string
  name: string
  type: PropertyType
  isRequired?: boolean
}

export interface NewProperty {
  name: string
  type: PropertyType
}

export interface PropertyTypeConfig {
  label: string
  icon: LucideIcon
}

export const PROPERTY_TYPE_CONFIG: Record<PropertyType, PropertyTypeConfig> = {
  text: { label: 'Text', icon: AlignLeft },
  number: { label: 'Number', icon: Hash },
  date: { label: 'Date', icon: Calendar },
  checkbox: { label: 'Checkbox', icon: CheckSquare },
  url: { label: 'URL', icon: Link }
}

export const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_CONFIG) as PropertyType[]
