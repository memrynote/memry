import { registerWidget } from '@/lib/home/widget-registry'
import { RecentlyEditedWidget } from './recently-edited-widget'
import { RecentlyOpenedWidget } from './recently-opened-widget'
import { BookmarksWidget } from './bookmarks-widget'
import { TasksWidget } from './tasks-widget'
import { InboxWidget } from './inbox-widget'
import { FolderWidget } from './folder-widget'
import { FolderHeaderControls } from './folder-header-controls'
import { TasksWidgetConfigEditor } from './tasks-widget-config-editor'
import { TasksHeaderFilter, TasksHeaderCount } from './tasks-header'
import { InboxHeaderFilter, InboxHeaderCount } from './inbox-header'
import { InboxWidgetFooter } from './inbox-footer'
import { CalendarWidget } from './calendar-widget'
import { CalendarHeaderLabel, CalendarHeaderCount, CalendarFooter } from './calendar-header'
import { JournalWidget } from './journal-widget'
import { JournalHeaderStreak } from './journal-header'

registerWidget({
  type: 'recently-edited',
  titleKey: 'home.widget.recentlyEdited',
  icon: 'trending-up',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: {},
  Component: RecentlyEditedWidget
})

registerWidget({
  type: 'recently-opened',
  titleKey: 'home.widget.recentlyOpened',
  icon: 'clock',
  defaultLayout: { w: 4, h: 4 },
  defaultConfig: {},
  Component: RecentlyOpenedWidget
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
  ConfigEditor: TasksWidgetConfigEditor,
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
