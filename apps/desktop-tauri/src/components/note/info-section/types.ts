import {
  AlignLeft,
  Hash,
  Calendar,
  CheckSquare,
  Link,
  ListChecks,
  List,
  Layers,
  type AppIcon
} from '@/lib/icons'

export type PropertyType =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'status'
  | 'select'
  | 'multiselect'

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
  icon: AppIcon
}

export const PROPERTY_TYPE_CONFIG: Record<PropertyType, PropertyTypeConfig> = {
  text: { label: 'Text', icon: AlignLeft },
  number: { label: 'Number', icon: Hash },
  date: { label: 'Date', icon: Calendar },
  checkbox: { label: 'Checkbox', icon: CheckSquare },
  url: { label: 'URL', icon: Link },
  status: { label: 'Status', icon: ListChecks },
  select: { label: 'Select', icon: List },
  multiselect: { label: 'Multiselect', icon: Layers }
}

export const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_CONFIG) as PropertyType[]
