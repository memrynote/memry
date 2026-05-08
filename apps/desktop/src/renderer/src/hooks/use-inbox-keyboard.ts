import { useEffect } from 'react'
import type { InboxItemListItem } from '@memry/rpc/inbox'
import { toast } from 'sonner'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import { getI18n } from 'react-i18next'

export interface UseInboxKeyboardOptions {
  enabled: boolean
  isDetailPanelOpen: boolean
  isBulkFilePanelOpen: boolean
  isInBulkMode: boolean
  focusedItemId: string | null
  items: InboxItemListItem[]
  onRefresh: () => void
  onArchiveFocusedItem: (itemId: string, nextItemId: string | null) => void
  onOpenBulkArchiveDialog: () => void
  onOpenSourceUrl: (url: string) => void
}

export function useInboxKeyboard(options: UseInboxKeyboardOptions): void {
  const {
    enabled,
    isDetailPanelOpen,
    isBulkFilePanelOpen,
    isInBulkMode,
    focusedItemId,
    items,
    onRefresh,
    onArchiveFocusedItem,
    onOpenBulkArchiveDialog,
    onOpenSourceUrl
  } = options

  useEffect(() => {
    if (!enabled) return

    const handleGlobalKeyDown = (e: KeyboardEvent): void => {
      if (isDetailPanelOpen || isBulkFilePanelOpen) return

      if (isInputFocused()) return

      if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        onRefresh()
        toast.success(getI18n().getFixedT(null, 'inbox')('phaseI.toasts.inboxRefreshed'))
        return
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (isInBulkMode) {
          e.preventDefault()
          onOpenBulkArchiveDialog()
          return
        }

        if (focusedItemId && !isDetailPanelOpen) {
          e.preventDefault()
          const focusedItem = items.find((i) => i.id === focusedItemId)
          if (focusedItem) {
            const currentIndex = items.findIndex((i) => i.id === focusedItemId)
            const nextItem = items[currentIndex + 1] || items[currentIndex - 1]
            onArchiveFocusedItem(focusedItemId, nextItem?.id ?? null)
          }
        }
        return
      }

      if (e.key.toLowerCase() === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (focusedItemId) {
          const focusedItem = items.find((i) => i.id === focusedItemId)
          if (focusedItem?.sourceUrl) {
            e.preventDefault()
            onOpenSourceUrl(focusedItem.sourceUrl)
          }
        }
        return
      }
    }

    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [
    enabled,
    isDetailPanelOpen,
    isBulkFilePanelOpen,
    isInBulkMode,
    focusedItemId,
    items,
    onRefresh,
    onArchiveFocusedItem,
    onOpenBulkArchiveDialog,
    onOpenSourceUrl
  ])
}
