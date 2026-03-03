/**
 * Unsaved Changes Guard
 * Hook and dialog for handling unsaved changes on tab close
 */

import { useState, useCallback } from 'react'
import { useTabs } from '@/contexts/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

// =============================================================================
// TYPES
// =============================================================================

interface PendingClose {
  tabId: string
  groupId: string
  tabTitle: string
}

interface UseUnsavedChangesGuardResult {
  /** Request to close a tab (returns true if OK to close immediately) */
  requestClose: (tabId: string, groupId: string) => boolean
  /** Pending close info */
  pendingClose: PendingClose | null
  /** Clear pending close */
  clearPendingClose: () => void
  /** Confirm close (discard changes) */
  confirmClose: () => void
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Hook to guard against closing tabs with unsaved changes
 */
export const useUnsavedChangesGuard = (): UseUnsavedChangesGuardResult => {
  const { state, closeTab } = useTabs()
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null)

  const requestClose = useCallback(
    (tabId: string, groupId: string): boolean => {
      const group = state.tabGroups[groupId]
      const tab = group?.tabs.find((t) => t.id === tabId)

      if (tab?.isModified) {
        setPendingClose({
          tabId,
          groupId,
          tabTitle: tab.title
        })
        return false // Don't close yet
      }

      return true // OK to close
    },
    [state.tabGroups]
  )

  const clearPendingClose = useCallback(() => {
    setPendingClose(null)
  }, [])

  const confirmClose = useCallback(() => {
    if (pendingClose) {
      closeTab(pendingClose.tabId, pendingClose.groupId)
      setPendingClose(null)
    }
  }, [pendingClose, closeTab])

  return {
    requestClose,
    pendingClose,
    clearPendingClose,
    confirmClose
  }
}

// =============================================================================
// DIALOG COMPONENT
// =============================================================================

interface UnsavedChangesDialogProps {
  /** Whether dialog is open */
  isOpen: boolean
  /** Tab title */
  tabTitle: string
  /** Save handler */
  onSave?: () => void
  /** Discard handler */
  onDiscard: () => void
  /** Cancel handler */
  onCancel: () => void
}

/**
 * Confirmation dialog for unsaved changes
 */
export const UnsavedChangesDialog = ({
  isOpen,
  tabTitle,
  onSave,
  onDiscard,
  onCancel
}: UnsavedChangesDialogProps): React.JSX.Element => {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
          <AlertDialogDescription>
            &quot;{tabTitle}&quot; has unsaved changes. What would you like to do?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onDiscard} className="bg-red-500 hover:bg-red-600">
            Don&apos;t Save
          </AlertDialogAction>
          {onSave && <AlertDialogAction onClick={onSave}>Save</AlertDialogAction>}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default UnsavedChangesDialog
