export type PropertyType =
  | 'text'
  | 'longText'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'multiSelect'
  | 'rating'
  | 'url'
  | 'relation'
  | 'person'

export interface Property {
  id: string
  name: string
  type: PropertyType
  value: unknown
  icon?: string
  isCustom: boolean
  isRequired?: boolean
  options?: string[]
}

export interface PropertyTemplate {
  id: string
  name: string
  type: PropertyType
  icon?: string
  isRequired?: boolean
  options?: string[]
}

export interface NewProperty {
  name: string
  type: PropertyType
}

export const PROPERTY_TYPE_CONFIG: Record<
  PropertyType,
  { label: string; icon: string }
> = {
  text: { label: 'Text', icon: '📝' },
  longText: { label: 'Long Text', icon: '📄' },
  number: { label: 'Number', icon: '🔢' },
  date: { label: 'Date', icon: '📅' },
  checkbox: { label: 'Checkbox', icon: '☑️' },
  select: { label: 'Select', icon: '📋' },
  multiSelect: { label: 'Multi-Select', icon: '🏷' },
  rating: { label: 'Rating', icon: '⭐' },
  url: { label: 'URL', icon: '🔗' },
  relation: { label: 'Relation', icon: '📎' },
  person: { label: 'Person', icon: '👤' }
}

export const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_CONFIG) as PropertyType[]
