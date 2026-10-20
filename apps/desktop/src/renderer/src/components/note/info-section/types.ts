import {
  AlignLeft,
  Hash,
  Calendar,
  CheckSquare,
  Link,
  Link2,
  ListChecks,
  List,
  Layers,
  FolderKanban,
  type AppIcon
} from '@/lib/icons'
import type { TaskStatusCategory } from '@memry/shared/note-status'

export type PropertyType =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'status'
  | 'select'
  | 'multiselect'
  | 'relation'
  | 'project'

export interface Property {
  id: string
  name: string
  type: PropertyType
  value: unknown
  isCustom: boolean
  isRequired?: boolean
  /**
   * Where the note's own tasks sit. A status property that carries them shows
   * the status they imply and cannot be edited (#3176).
   */
  derivedFrom?: TaskStatusCategory[]
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
  multiselect: { label: 'Multiselect', icon: Layers },
  relation: { label: 'Relation', icon: Link2 },
  project: { label: 'Project', icon: FolderKanban }
}

export const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_CONFIG) as PropertyType[]
