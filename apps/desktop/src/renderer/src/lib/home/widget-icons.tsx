import { Bookmark, Clock, Folder, FolderKanban, TrendingUp } from '@/lib/icons/icon-map'
import {
  PageCalendarIcon,
  PageInboxIcon,
  PageJournalIcon,
  PageTasksIcon
} from '@/lib/icons/page-icons'

// Maps the registry `icon` string to a component. Unknown names render no icon.
// Shared by the widget header (WidgetFrame) and the Add-widget gallery.
export const WIDGET_ICONS: Record<string, typeof Clock> = {
  clock: Clock,
  'trending-up': TrendingUp,
  bookmark: Bookmark,
  'check-square': PageTasksIcon,
  inbox: PageInboxIcon,
  folder: Folder,
  calendar: PageCalendarIcon,
  'book-open': PageJournalIcon,
  'folder-kanban': FolderKanban
}
