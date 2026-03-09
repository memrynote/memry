import { useEffect } from 'react'
import { isInputFocused } from '@/hooks/use-keyboard-shortcuts'
import type { InboxItemListItem } from '../../../preload/index.d'

export interface UseInboxKeyboardOptions {
  enabled: boolean
  isShortcutsModalOpen: boolean
  isDetailPanelOpen: boolean
  isBulkFilePanelOpen: boolean
  isInBulkMode: boolean
  focusedItemId: string | null
  items: InboxItemListItem[]
  staleItems: InboxItemListItem[]
  nonStaleItems: InboxItemListItem[]
  onOpenShortcutsModal: () => void
  onRefresh: () => void
  onArchiveFocusedItem: (itemId: string, nextItemId: string | null) => void
  onOpenBulkArchiveDialog: () => void
  onOpenSourceUrl: (url: string) => void
  addToast: (toast: { message: string; type: 'success' | 'error' | 'info' }) => void
}

export function useInboxKeyboard(options: UseInboxKeyboardOptions): void {
  const {
    enabled,
    isShortcutsModalOpen,
    isDetailPanelOpen,
    isBulkFilePanelOpen,
    isInBulkMode,
    focusedItemId,
    items,
    staleItems,
    nonStaleItems,
    onOpenShortcutsModal,
    onRefresh,
    onArchiveFocusedItem,
    onOpenBulkArchiveDialog,
    onOpenSourceUrl,
    addToast
  } = options

  useEffect(() => {
    if (!enabled) return

    const handleGlobalKeyDown = (e: KeyboardEvent): void => {
      if (isShortcutsModalOpen || isDetailPanelOpen || isBulkFilePanelOpen) return

      if (e.key === '?' || ((e.metaKey || e.ctrlKey) && e.key === '/')) {
        e.preventDefault()
        onOpenShortcutsModal()
        return
      }

      if (isInputFocused()) return

      if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        onRefresh()
        addToast({ message: 'Inbox refreshed', type: 'success' })
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
            const allItems = [...staleItems, ...nonStaleItems]
            const currentIndex = allItems.findIndex((i) => i.id === focusedItemId)
            const nextItem = allItems[currentIndex + 1] || allItems[currentIndex - 1]
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
    isShortcutsModalOpen,
    isDetailPanelOpen,
    isBulkFilePanelOpen,
    isInBulkMode,
    focusedItemId,
    items,
    staleItems,
    nonStaleItems,
    onOpenShortcutsModal,
    onRefresh,
    onArchiveFocusedItem,
    onOpenBulkArchiveDialog,
    onOpenSourceUrl,
    addToast
  ])
}
