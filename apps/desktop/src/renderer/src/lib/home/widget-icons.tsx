import {
  Bookmark,
  BookOpen,
  Calendar,
  CheckSquare,
  Clock,
  Folder,
  FolderKanban,
  Inbox,
  TrendingUp
} from '@/lib/icons/icon-map'

// Maps the registry `icon` string to a component. Unknown names render no icon.
// Shared by the widget header (WidgetFrame) and the Add-widget gallery.
export const WIDGET_ICONS: Record<string, typeof Clock> = {
  clock: Clock,
  'trending-up': TrendingUp,
  bookmark: Bookmark,
  'check-square': CheckSquare,
  inbox: Inbox,
  folder: Folder,
  calendar: Calendar,
  'book-open': BookOpen,
  'folder-kanban': FolderKanban
}
