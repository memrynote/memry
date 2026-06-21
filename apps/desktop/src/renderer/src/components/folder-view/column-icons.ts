/**
 * Shared leading-icon resolution for folder-view column/property lists.
 * Built-in columns get a mapped icon; custom properties fall back to a generic one.
 */

import { FileText, Folder, Tag, Calendar, Clock, Hash, Type, type AppIcon } from '@/lib/icons'

const BUILTIN_ICONS: Record<string, AppIcon> = {
  title: FileText,
  folder: Folder,
  tags: Tag,
  created: Calendar,
  modified: Clock,
  wordCount: Hash
}

/** Resolve the leading icon for a column id (built-in mapped, custom → generic). */
export function getColumnIcon(id: string): AppIcon {
  return BUILTIN_ICONS[id] ?? Type
}
