import { useState, useCallback } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Loader2 } from 'lucide-react'

interface DeviceRevokedDialogProps {
  open: boolean
  unsyncedCount: number
  onExport: () => Promise<void>
  onSignOut: () => void
}

export function DeviceRevokedDialog({
  open,
  unsyncedCount,
  onExport,
  onSignOut
}: DeviceRevokedDialogProps): React.JSX.Element {
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState(false)

  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      await onExport()
      setExported(true)
    } finally {
      setExporting(false)
    }
  }, [onExport])

  const hasUnsynced = unsyncedCount > 0

  return (
    <AlertDialog open={open}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 dark:bg-amber-400/10">
              <AlertTriangle
                className="w-5 h-5 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            </div>
            <AlertDialogTitle className="font-display text-xl tracking-tight">
              This device has been removed
            </AlertDialogTitle>
          </div>
          <AlertDialogDescription className="font-serif text-[15px] leading-relaxed">
            {hasUnsynced
              ? `Another device removed this device from your account. ${unsyncedCount} item${unsyncedCount === 1 ? '' : 's'} haven't been synced yet.`
              : 'Another device removed this device from your account. All your data is safely synced.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter className="gap-2 sm:gap-0">
          {hasUnsynced && (
            <Button
              variant="outline"
              onClick={() => void handleExport()}
              disabled={exporting || exported}
            >
              {exporting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Exporting...
                </>
              ) : exported ? (
                'Exported'
              ) : (
                'Export Local Data'
              )}
            </Button>
          )}
          <Button onClick={onSignOut}>Sign Out</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
