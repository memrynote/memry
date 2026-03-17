/**
 * Tab Icon Component
 * Maps tab types to Hugeicons
 * Memoized to prevent unnecessary re-renders
 */

import { memo } from 'react'
import {
  Inbox,
  Home,
  ListChecks,
  Star,
  Calendar,
  CheckCircle,
  Folder,
  FileText,
  BookOpen,
  Search,
  Settings,
  Bookmark,
  File,
  LayoutTemplate,
  FileType2,
  GitGraph,
  Image,
  Music,
  Video
} from '@/lib/icons'
import type { TabType } from '@/contexts/tabs/types'
import { cn } from '@/lib/utils'

interface TabIconProps {
  /** Tab type for default icon lookup */
  type: TabType
  /** Optional override icon name */
  icon?: string
  /** Optional emoji (overrides icon) */
  emoji?: string | null
  /** CSS classes */
  className?: string
}

/**
 * Icon component mapping for tab icons
 */
const ICON_COMPONENTS: Record<string, React.ComponentType<{ className?: string }>> = {
  // Core icons
  inbox: Inbox,
  home: Home,
  'list-checks': ListChecks,
  star: Star,
  calendar: Calendar,
  'check-circle': CheckCircle,
  folder: Folder,
  'file-text': FileText,
  'book-open': BookOpen,
  search: Search,
  settings: Settings,
  bookmark: Bookmark,
  file: File,
  'layout-template': LayoutTemplate,
  // File type icons
  'file-pdf': FileType2,
  'file-image': Image,
  'file-audio': Music,
  'file-video': Video,
  'git-graph': GitGraph
}

/**
 * Default icon mapping for tab types
 */
const TYPE_TO_ICON: Record<TabType, string> = {
  inbox: 'inbox',
  home: 'home',
  tasks: 'list-checks', // New unified tasks tab
  'all-tasks': 'list-checks',
  today: 'star',
  completed: 'check-circle',
  project: 'folder',
  note: 'file-text',
  file: 'file', // Non-markdown files (icon overridden based on file type)
  folder: 'folder', // Folder view
  journal: 'book-open',
  search: 'search',
  settings: 'settings',
  collection: 'bookmark',
  'template-editor': 'layout-template',
  templates: 'layout-template',
  graph: 'git-graph'
}

/**
 * Renders the appropriate icon for a tab
 * If emoji is provided, renders emoji instead of icon
 * Memoized to prevent unnecessary re-renders
 */
const TabIconComponent = ({ type, icon, emoji, className }: TabIconProps): React.JSX.Element => {
  // If emoji is provided, render it instead of icon
  if (emoji) {
    return <span className={cn('shrink-0 text-center leading-none', className)}>{emoji}</span>
  }

  // Use provided icon name or fall back to type-based default
  const iconName = icon || TYPE_TO_ICON[type] || 'file'
  const IconComponent = ICON_COMPONENTS[iconName] || File

  return <IconComponent className={cn('shrink-0', className)} />
}

export const TabIcon = memo(TabIconComponent)

export default TabIcon
