import type { SidebarItem } from '@/contexts/tabs/types'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'

/**
 * The sidebar item a folder-view row opens as. A tag scope can list tasks and
 * inbox items beside notes, and those live on their own pages — so the row's
 * `kind`, not the page, decides where it goes. Shared by every surface that
 * lists these rows (the folder/tag page and the view block in a note) and by
 * both the plain open and the middle-click background open, so a row lands in
 * the same place either way.
 */
export function sidebarItemForRow(item: NoteWithProperties): SidebarItem {
  const kind = item.kind ?? 'note'

  if (kind === 'task') {
    return {
      type: 'tasks',
      title: 'Tasks',
      icon: 'CheckSquare',
      path: '/tasks',
      // No `selectedProjectId`: under tag scope a row carries no project id,
      // only a folder name, so the Tasks page falls back to its default
      // project scope.
      viewState: { openTaskId: item.id, activeInternalTab: 'all', activeTab: 'all' }
    }
  }

  if (kind === 'inbox') {
    return {
      type: 'inbox',
      title: 'Inbox',
      icon: 'Inbox',
      path: '/inbox',
      // Fresh `focusedAt` token so Inbox's focus effect re-fires even when the
      // same item is opened twice in a row (it dedupes on the token) — see
      // inbox.tsx's focus effect.
      viewState: { focusInboxItemId: item.id, focusedAt: Date.now() }
    }
  }

  return { type: 'note', path: item.path, entityId: item.id, title: item.title, emoji: item.emoji }
}
