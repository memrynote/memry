/**
 * Bookmark row presentation
 *
 * One definition of "what does this bookmark look like and what tab does it
 * open", shared by the sidebar bookmark list and the Home bookmarks widget so
 * a folder or tag bookmark never opens as a note in one of them.
 */

import { FileText, Calendar, CheckSquare, Image, FileAudio, File, Folder, Hash } from '@/lib/icons'
import { BookmarkItemTypes, type BookmarkWithItem } from '@memry/contracts/bookmarks-api'
import type { SidebarItem, TabType } from '@/contexts/tabs/types'

const ICON_BY_ITEM_TYPE: Record<string, typeof File> = {
  [BookmarkItemTypes.NOTE]: FileText,
  [BookmarkItemTypes.JOURNAL]: Calendar,
  [BookmarkItemTypes.TASK]: CheckSquare,
  [BookmarkItemTypes.FOLDER]: Folder,
  [BookmarkItemTypes.TAG]: Hash,
  [BookmarkItemTypes.IMAGE]: Image,
  [BookmarkItemTypes.AUDIO]: FileAudio
}

export const bookmarkIcon = (itemType: string): typeof File => ICON_BY_ITEM_TYPE[itemType] ?? File

const TAB_TYPE_BY_ITEM_TYPE: Record<string, TabType> = {
  [BookmarkItemTypes.NOTE]: 'note',
  [BookmarkItemTypes.JOURNAL]: 'journal',
  [BookmarkItemTypes.TASK]: 'tasks',
  [BookmarkItemTypes.FOLDER]: 'folder',
  [BookmarkItemTypes.TAG]: 'tag'
}

/**
 * Folder and tag bookmarks are keyed by path and name, so their routes are
 * built from the id; the other types keep the resolved item path.
 */
const bookmarkPath = (bookmark: BookmarkWithItem): string => {
  switch (bookmark.itemType) {
    case BookmarkItemTypes.FOLDER:
      return `/folder/${encodeURIComponent(bookmark.itemId)}`
    case BookmarkItemTypes.TAG:
      return `/tags/${bookmark.itemId}`
    default:
      return bookmark.itemMeta?.path || `/${bookmark.itemType}/${bookmark.itemId}`
  }
}

/** `untitledLabel` is passed in because this module is not a component. */
export const bookmarkSidebarItem = (
  bookmark: BookmarkWithItem,
  untitledLabel: string
): SidebarItem => ({
  type: TAB_TYPE_BY_ITEM_TYPE[bookmark.itemType] ?? 'note',
  title: bookmark.itemTitle || untitledLabel,
  emoji: bookmark.itemMeta?.emoji,
  path: bookmarkPath(bookmark),
  entityId: bookmark.itemId
})
