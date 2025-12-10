import {
  AlignLeft,
  FileText,
  Hash,
  Calendar,
  CheckSquare,
  List,
  Tags,
  Star,
  Link,
  CornerUpRight,
  User,
  type LucideIcon
} from 'lucide-react'

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
  isCustom: boolean
  isRequired?: boolean
  options?: string[]
}

export interface PropertyTemplate {
  id: string
  name: string
  type: PropertyType
  isRequired?: boolean
  options?: string[]
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
  longText: { label: 'Long Text', icon: FileText },
  number: { label: 'Number', icon: Hash },
  date: { label: 'Date', icon: Calendar },
  checkbox: { label: 'Checkbox', icon: CheckSquare },
  select: { label: 'Select', icon: List },
  multiSelect: { label: 'Multi-Select', icon: Tags },
  rating: { label: 'Rating', icon: Star },
  url: { label: 'URL', icon: Link },
  relation: { label: 'Relation', icon: CornerUpRight },
  person: { label: 'Person', icon: User }
}

export const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_CONFIG) as PropertyType[]
