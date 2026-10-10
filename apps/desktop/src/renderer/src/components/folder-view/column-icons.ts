/**
 * Shared leading-icon resolution for folder-view column/property lists.
 * Built-in columns get a mapped icon; custom properties use their type's icon.
 */

import type { PropertyType } from './property-cell'
import {
  AlignLeft,
  FileText,
  Folder,
  FolderKanban,
  Tag,
  Tags,
  Calendar,
  CheckSquare,
  Clock,
  Hash,
  Link,
  Link2,
  List,
  Star,
  Type,
  type AppIcon
} from '@/lib/icons'

const BUILTIN_ICONS: Record<string, AppIcon> = {
  title: FileText,
  folder: Folder,
  tags: Tag,
  created: Calendar,
  modified: Clock,
  wordCount: Hash
}

// Partial: stored types outside this union (e.g. `status`) reach callers at runtime.
export const PROPERTY_TYPE_ICONS: Partial<Record<PropertyType, AppIcon>> = {
  text: AlignLeft,
  number: Hash,
  checkbox: CheckSquare,
  date: Calendar,
  select: List,
  multiselect: Tags,
  url: Link,
  rating: Star,
  relation: Link2,
  project: FolderKanban
}

/** Resolve the leading icon for a column id: built-in mapped, custom by its type, else generic. */
export function getColumnIcon(id: string, type?: PropertyType): AppIcon {
  return BUILTIN_ICONS[id] ?? (type && PROPERTY_TYPE_ICONS[type]) ?? Type
}
