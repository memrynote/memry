import type { useTabActions } from '@/contexts/tabs'
import { FOLDER_VIEW_STATE_KEYS } from '@/pages/folder-view-state'

type OpenTab = ReturnType<typeof useTabActions>['openTab']

/** Opens a tag's table in a new tab, narrowed by `filter` (a removable, saveable filter). */
export function openTagTable(openTab: OpenTab, tag: string, filter?: string): void {
  openTab(
    {
      type: 'tag',
      title: tag,
      icon: 'tag',
      path: `/tags/${tag}`,
      entityId: tag,
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      ...(filter && { viewState: { [FOLDER_VIEW_STATE_KEYS.linkedFilter]: filter } })
    },
    { forceNew: true }
  )
}
