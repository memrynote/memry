import { registerWidget } from '@/lib/home/widget-registry'
import { RecentlyEditedWidget } from './recently-edited-widget'
import { BookmarksWidget } from './bookmarks-widget'
import { TasksWidget } from './tasks-widget'
import { InboxWidget } from './inbox-widget'
import { FolderWidget } from './folder-widget'
import { FolderWidgetConfigEditor } from './folder-widget-config-editor'
import { TasksWidgetConfigEditor } from './tasks-widget-config-editor'

registerWidget({
  type: 'recently-edited',
  titleKey: 'home.widget.recentlyEdited',
  icon: 'clock',
  sizes: ['S', 'M'],
  defaultSize: 'M',
  defaultConfig: {},
  Component: RecentlyEditedWidget
})

registerWidget({
  type: 'bookmarks',
  titleKey: 'home.widget.bookmarks',
  icon: 'bookmark',
  sizes: ['S', 'M'],
  defaultSize: 'M',
  defaultConfig: {},
  Component: BookmarksWidget
})

registerWidget({
  type: 'tasks',
  titleKey: 'home.widget.tasks',
  icon: 'check-square',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'M',
  defaultConfig: { dateRange: 'today' },
  Component: TasksWidget,
  ConfigEditor: TasksWidgetConfigEditor
})

registerWidget({
  type: 'inbox',
  titleKey: 'home.widget.inbox',
  icon: 'inbox',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'M',
  defaultConfig: {},
  Component: InboxWidget
})

registerWidget({
  type: 'folder',
  titleKey: 'home.widget.folder',
  icon: 'folder',
  sizes: ['M', 'L'],
  defaultSize: 'M',
  defaultConfig: { folderPath: '', viewType: 'list' },
  Component: FolderWidget,
  ConfigEditor: FolderWidgetConfigEditor
})
