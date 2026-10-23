import { useEffect, useRef } from 'react'
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

  // `items` gets a new identity on every refetch/optimistic update, and the
  // panel/focus flags change constantly. Read the handler from a ref so the
  // window listener binds once instead of rebinding on every one of those.
  const handleGlobalKeyDownRef = useRef(handleGlobalKeyDown)
  useEffect(() => {
    handleGlobalKeyDownRef.current = handleGlobalKeyDown
  })

  useEffect(() => {
    if (!enabled) return

    const listener = (e: KeyboardEvent): void => handleGlobalKeyDownRef.current(e)

    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [enabled])
}
