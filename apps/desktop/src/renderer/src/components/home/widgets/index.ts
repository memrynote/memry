import { registerWidget } from '@/lib/home/widget-registry'
import { RecentlyEditedWidget } from './recently-edited-widget'
import { BookmarksWidget } from './bookmarks-widget'
import { TasksWidget } from './tasks-widget'
import { InboxWidget } from './inbox-widget'
import { FolderWidget } from './folder-widget'
import { FolderHeaderControls } from './folder-header-controls'
import { TasksHeaderFilter, TasksHeaderCount } from './tasks-header'
import { InboxHeaderFilter, InboxHeaderCount } from './inbox-header'
import { InboxWidgetFooter } from './inbox-footer'
import { CalendarWidget } from './calendar-widget'
import { CalendarHeaderLabel, CalendarHeaderCount, CalendarFooter } from './calendar-header'
import { JournalWidget } from './journal-widget'
import { JournalHeaderStreak } from './journal-header'
import { ProjectWidget } from './project-widget'
import { ProjectWidgetPicker } from './project-widget-picker'

registerWidget({
  type: 'recently-edited',
  titleKey: 'home.widget.recentlyEdited',
  icon: 'trending-up',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: {},
  Component: RecentlyEditedWidget
})

registerWidget({
  type: 'bookmarks',
  titleKey: 'home.widget.bookmarks',
  icon: 'bookmark',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: {},
  Component: BookmarksWidget
})

registerWidget({
  type: 'tasks',
  titleKey: 'home.widget.tasks',
  icon: 'check-square',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: { dateRange: 'today' },
  Component: TasksWidget,
  HeaderFilter: TasksHeaderFilter,
  HeaderCount: TasksHeaderCount
})

registerWidget({
  type: 'inbox',
  titleKey: 'home.widget.inbox',
  icon: 'inbox',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: {},
  Component: InboxWidget,
  HeaderFilter: InboxHeaderFilter,
  HeaderCount: InboxHeaderCount,
  Footer: InboxWidgetFooter
})

registerWidget({
  type: 'folder',
  titleKey: 'home.widget.folder',
  icon: 'folder',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: { folderPath: '' },
  Component: FolderWidget,
  HeaderFilter: FolderHeaderControls
})

registerWidget({
  type: 'calendar',
  titleKey: 'home.widget.calendar',
  icon: 'calendar',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: {},
  Component: CalendarWidget,
  HeaderFilter: CalendarHeaderLabel,
  HeaderCount: CalendarHeaderCount,
  Footer: CalendarFooter
})

registerWidget({
  type: 'journal',
  titleKey: 'home.widget.journal',
  icon: 'book-open',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: {},
  Component: JournalWidget,
  HeaderFilter: JournalHeaderStreak
})

registerWidget({
  type: 'project',
  titleKey: 'home.widget.project',
  icon: 'folder-kanban',
  // Taller and wider than the default 4x4: the body carries a five-tab strip above
  // its rows, and five labels need roughly half the board's width to sit on one line.
  defaultLayout: { w: 4, h: 5 },
  minLayout: { w: 4, h: 3 },
  defaultConfig: { projectId: '' },
  Component: ProjectWidget,
  HeaderFilter: ProjectWidgetPicker
})
