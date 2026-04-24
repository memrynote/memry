import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Copy, Eye, EyeOff, Key } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'

interface RecoveryKeyDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RecoveryKeyDialog({ open, onOpenChange }: RecoveryKeyDialogProps) {
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [revealed, setRevealed] = useState(false)

  const handleOpen = useCallback(
    async (nextOpen: boolean) => {
      if (!nextOpen) {
        setRecoveryKey(null)
        setRevealed(false)
        onOpenChange(false)
        return
      }
      setIsLoading(true)
      onOpenChange(true)
      try {
        const result = await invoke<{ success: boolean; key?: string; error?: string }>(
          'account_get_recovery_key'
        )
        if (!result.success || !result.key) {
          toast.error(result.error ?? 'Failed to retrieve recovery key')
          onOpenChange(false)
          return
        }
        setRecoveryKey(result.key)
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to retrieve recovery key'))
        onOpenChange(false)
      } finally {
        setIsLoading(false)
      }
    },
    [onOpenChange]
  )

  const handleCopy = useCallback(async () => {
    if (!recoveryKey) return
    try {
      await navigator.clipboard.writeText(recoveryKey)
      toast.success('Recovery key copied to clipboard')
    } catch {
      toast.error('Failed to copy to clipboard')
    }
  }, [recoveryKey])

  return (
    <Dialog open={open} onOpenChange={(next) => void handleOpen(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Key className="w-5 h-5 text-primary" />
            <DialogTitle>Recovery Key</DialogTitle>
          </div>
          <DialogDescription>
            Store this key securely. It can restore your vault if you lose access to all devices.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {isLoading ? (
            <div className="flex items-center justify-center h-20">
              <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
          ) : recoveryKey ? (
            <div className="space-y-3">
              <div className="relative">
                <div
                  className={`font-mono text-xs p-4 rounded-md bg-muted break-all leading-relaxed select-all transition-all ${
                    !revealed ? 'blur-sm select-none cursor-pointer' : ''
                  }`}
                  onClick={() => setRevealed(true)}
                  onKeyDown={(e) => e.key === 'Enter' && setRevealed(true)}
                  role={revealed ? undefined : 'button'}
                  tabIndex={revealed ? undefined : 0}
                >
                  {recoveryKey}
                </div>
                {!revealed && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-md">
                    <div className="flex items-center gap-2 bg-background/90 px-3 py-1.5 rounded-md text-xs text-muted-foreground border">
                      <EyeOff className="w-3.5 h-3.5" />
                      Click to reveal
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => setRevealed((r) => !r)}
                >
                  {revealed ? (
                    <>
                      <EyeOff className="w-4 h-4" />
                      Hide
                    </>
                  ) : (
                    <>
                      <Eye className="w-4 h-4" />
                      Reveal
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => void handleCopy()}
                >
                  <Copy className="w-4 h-4" />
                  Copy
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                This key is shown once per session. Close this dialog to clear it from memory.
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
