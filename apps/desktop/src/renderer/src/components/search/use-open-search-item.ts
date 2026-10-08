import { useCallback } from 'react'
import type { ContentType, SearchResultItem } from '@memry/contracts/search-api'
import { getTabIconForFileType } from '@memry/shared/file-types'
import { useTabs } from '@/contexts/tabs'
import { trackTelemetry } from '@/lib/telemetry'

export interface OpenableSearchItem {
  id: string
  title: string
  type: ContentType
  metadata?: SearchResultItem['metadata']
}

/** Opens a search hit in the tab its type belongs to. */
export function useOpenSearchItem(): (item: OpenableSearchItem) => void {
  const { openTab } = useTabs()
  return useCallback(
    (item: OpenableSearchItem) => {
      void trackTelemetry('search_result_opened', {
        surface: 'search',
        action: 'opened',
        objectType: item.type
      })
      switch (item.type) {
        case 'note': {
          // A "note" search result can actually be a filed binary (image/PDF/…).
          // Open those via the file viewer with the correct icon, never the
          // markdown editor (which would render raw bytes / freeze). See #800.
          const fileType = item.metadata?.type === 'note' ? item.metadata.fileType : undefined
          const isMarkdown = !fileType || fileType === 'markdown'
          openTab({
            type: isMarkdown ? 'note' : 'file',
            title: item.title,
            icon: isMarkdown ? 'file-text' : getTabIconForFileType(fileType),
            path: isMarkdown ? `/note/${item.id}` : `/file/${item.id}`,
            entityId: item.id,
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          })
          break
        }
        case 'journal': {
          const date = item.metadata?.type === 'journal' ? item.metadata.date : item.id
          openTab({
            type: 'journal',
            title: `Journal — ${date}`,
            icon: 'book-open',
            path: `/journal/${date}`,
            entityId: item.id,
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          })
          break
        }
        case 'task':
          openTab({
            type: 'tasks',
            title: 'Tasks',
            icon: 'check-square',
            path: '/tasks',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false,
            viewState: {
              // `openTaskId` is the key the tasks page actually reads, and the
              // detail drawer opens off the resolved task — including an
              // archived one, which the list itself hides. `focusTaskId` was
              // read by nothing, so archived hits landed on an empty overview.
              openTaskId: item.id,
              activeInternalTab: 'all',
              activeTab: 'all',
              projectId: item.metadata?.type === 'task' ? item.metadata.projectId : undefined
            }
          })
          break
        case 'inbox':
          openTab({
            type: 'inbox',
            title: 'Inbox',
            icon: 'inbox',
            path: '/inbox',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false,
            viewState: { highlightItemId: item.id }
          })
          break
      }
    },
    [openTab]
  )
}
