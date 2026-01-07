import { Archive, Trash2, Clock } from 'lucide-react'

import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

// ============================================================================
// TYPES
// ============================================================================

interface ClearCompletedMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onArchiveAll: () => void
  onArchiveOlderThan: (days: number) => void
  onDeleteAll: () => void
  onViewArchived?: () => void
  completedCount: number
  archivedCount?: number
}

// ============================================================================
// CLEAR COMPLETED MENU
// ============================================================================

export const ClearCompletedMenu = ({
  open,
  onOpenChange,
  onArchiveAll,
  onArchiveOlderThan,
  onDeleteAll,
  onViewArchived,
  completedCount,
  archivedCount = 0
}: ClearCompletedMenuProps): React.JSX.Element => {
  const handleArchiveAll = (): void => {
    onArchiveAll()
    onOpenChange(false)
  }

  const handleArchiveOlder = (days: number) => (): void => {
    onArchiveOlderThan(days)
    onOpenChange(false)
  }

  const handleDeleteAll = (): void => {
    onDeleteAll()
    onOpenChange(false)
  }

  const handleViewArchived = (): void => {
    onViewArchived?.()
    onOpenChange(false)
  }

  const handleClose = (): void => {
    onOpenChange(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-xs p-0">
        <div className="p-2 space-y-1">
          <Button
            variant="ghost"
            className="w-full justify-start h-9 px-3"
            onClick={handleArchiveAll}
            disabled={completedCount === 0}
          >
            <Archive className="size-4 mr-2" aria-hidden="true" />
            Archive all ({completedCount})
          </Button>

          <div className="h-px bg-border mx-2" />

          <Button
            variant="ghost"
            className="w-full justify-start h-9 px-3"
            onClick={handleArchiveOlder(7)}
            disabled={completedCount === 0}
          >
            <Clock className="size-4 mr-2" aria-hidden="true" />
            Archive older than 7 days
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start h-9 px-3"
            onClick={handleArchiveOlder(30)}
            disabled={completedCount === 0}
          >
            <Clock className="size-4 mr-2" aria-hidden="true" />
            Archive older than 30 days
          </Button>

          <div className="h-px bg-border mx-2" />

          <Button
            variant="ghost"
            className="w-full justify-start h-9 px-3 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleDeleteAll}
            disabled={completedCount === 0}
          >
            <Trash2 className="size-4 mr-2" aria-hidden="true" />
            Delete all permanently
          </Button>

          {onViewArchived && (
            <>
              <div className="h-px bg-border mx-2" />

              <Button
                variant="ghost"
                className="w-full justify-start h-9 px-3"
                onClick={handleViewArchived}
              >
                <Archive className="size-4 mr-2" aria-hidden="true" />
                View archived{archivedCount > 0 ? ` (${archivedCount})` : ''}
              </Button>
            </>
          )}

          <div className="h-px bg-border mx-2" />

          <Button variant="ghost" className="w-full justify-start h-9 px-3" onClick={handleClose}>
            Cancel
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default ClearCompletedMenu
