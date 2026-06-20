import { registerWidget } from '@/lib/home/widget-registry'
import { RecentlyEditedWidget } from './recently-edited-widget'
import { BookmarksWidget } from './bookmarks-widget'

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
