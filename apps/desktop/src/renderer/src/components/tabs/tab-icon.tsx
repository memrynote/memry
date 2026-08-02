/**
 * Tab Icon Component
 * Maps tab types to Hugeicons
 * Memoized to prevent unnecessary re-renders
 */

import { memo } from 'react'
import {
  Inbox,
  Home,
  CheckSquare3,
  Star,
  Calendar2,
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
  ChartRelationship,
  Image,
  Music,
  Video,
  Bot,
  PenTool
} from '@/lib/icons'
import type { TabType } from '@/contexts/tabs/types'
import { cn } from '@/lib/utils'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { ProjectIcon } from '@/components/tasks/project-icon'
import { useTasksOptional } from '@/contexts/tasks'

interface TabIconProps {
  /** Tab type for default icon lookup */
  type: TabType
  /** Optional override icon name */
  icon?: string
  /** Optional emoji (overrides icon) */
  emoji?: string | null
  /** Entity the tab points at — project tabs resolve their icon/color from it */
  entityId?: string
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
  'list-checks': CheckSquare3,
  star: Star,
  calendar: Calendar2,
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
  graph: ChartRelationship,
  bot: Bot,
  'pen-tool': PenTool
}

/**
 * Default icon mapping for tab types
 */
const TYPE_TO_ICON: Record<TabType, string> = {
  home: 'home',
  inbox: 'inbox',
  calendar: 'calendar',
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
  collection: 'bookmark',
  'template-editor': 'layout-template',
  templates: 'layout-template',
  graph: 'graph',
  'agent-chat': 'bot',
  canvas: 'pen-tool',
  'virtual-note': 'file-text'
}

/**
 * Project tabs show the project's own emoji/icon tinted with its color, and the
 * project color dot when no custom icon is set — the same treatment the sidebar
 * drop zones and project picker use. Reading from the tasks context instead of
 * the stored tab icon keeps an open tab in sync when the project is edited.
 */
const ProjectTabIcon = ({
  projectId,
  className
}: {
  projectId: string
  className?: string
}): React.JSX.Element => {
  const tasksContext = useTasksOptional()
  const project = tasksContext?.projects.find((p) => p.id === projectId)

  if (!project) return <Folder className={cn('shrink-0', className)} />

  return (
    <ProjectIcon
      icon={project.icon}
      color={project.color}
      className={cn('shrink-0', className)}
      fallback={
        <span
          className={cn('inline-flex shrink-0 items-center justify-center', className)}
          aria-hidden="true"
        >
          <span
            data-testid="project-tab-color-dot"
            className="size-2.5 rounded-full"
            style={{ backgroundColor: project.color }}
          />
        </span>
      }
    />
  )
}

/**
 * Renders the appropriate icon for a tab
 * If emoji is provided, renders emoji instead of icon
 * Memoized to prevent unnecessary re-renders
 */
const TabIconComponent = ({
  type,
  icon,
  emoji,
  entityId,
  className
}: TabIconProps): React.JSX.Element => {
  if (type === 'project' && entityId) {
    return <ProjectTabIcon projectId={entityId} className={className} />
  }

  if (emoji) {
    return (
      <NoteIconDisplay
        value={emoji}
        className={cn('shrink-0 text-center leading-none', className)}
      />
    )
  }

  // Use provided icon name or fall back to type-based default
  const iconName = icon || TYPE_TO_ICON[type] || 'file'
  const IconComponent = ICON_COMPONENTS[iconName] || File

  return <IconComponent className={cn('shrink-0', className)} />
}

export const TabIcon = memo(TabIconComponent)

export default TabIcon
