import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
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
import { User, LogOut, HardDrive, CalendarDays, Key } from '@/lib/icons'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAuth } from '@/contexts/auth-context'
import { useAccountInfo } from '@/hooks/use-account-info'
import { RecoveryKeyDialog } from '@/components/settings/recovery-key-dialog'
import type { StorageBreakdownResult } from '@memry/contracts/ipc-sync-ops'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AccountSettings() {
  const { state, logout } = useAuth()
  const { accountInfo, isLoading: infoLoading } = useAccountInfo()
  const [storage, setStorage] = useState<StorageBreakdownResult | null>(null)
  const [showSignOutDialog, setShowSignOutDialog] = useState(false)
  const [showRecoveryKey, setShowRecoveryKey] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  useEffect(() => {
    if (state.status !== 'authenticated') return
    window.api.syncOps
      .getStorageBreakdown()
      .then(setStorage)
      .catch(() => null)
  }, [state.status])

  const handleSignOut = useCallback(async () => {
    setSigningOut(true)
    try {
      await logout()
      toast.success('Signed out successfully')
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, 'Failed to sign out'))
    } finally {
      setSigningOut(false)
      setShowSignOutDialog(false)
    }
  }, [logout])

  if (state.status === 'checking' || infoLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Account</h3>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (state.status !== 'authenticated') {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Account</h3>
          <p className="text-sm text-muted-foreground">Not signed in</p>
        </div>
        <Separator />
        <p className="text-sm text-muted-foreground">
          Sign in via the Sync section to access account settings.
        </p>
      </div>
    )
  }

  const email = accountInfo?.email ?? state.email
  const joinedAt = accountInfo?.joinedAt

  const storageUsedPct =
    storage && storage.limit > 0 ? Math.min(100, (storage.used / storage.limit) * 100) : null

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Account</h3>
        <p className="text-sm text-muted-foreground">Manage your account and sign out</p>
      </div>

      <Separator />

      {/* Identity */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Identity</h4>
        <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
          <div className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 shrink-0">
            <User className="w-4 h-4 text-primary" />
          </div>
          <div className="space-y-0.5 min-w-0">
            <p className="text-sm font-medium truncate">{email ?? 'Unknown'}</p>
            {joinedAt && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarDays className="w-3 h-3" />
                <span>Member since {format(new Date(joinedAt), 'MMMM yyyy')}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Storage */}
      {storage && (
        <>
          <Separator />
          <div className="space-y-3">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <HardDrive className="w-4 h-4" />
              Storage
            </h4>
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{formatBytes(storage.used)} used</span>
                <span>{formatBytes(storage.limit)} total</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${storageUsedPct ?? 0}%` }}
                />
              </div>
              <div className="grid grid-cols-4 gap-2 pt-1">
                {Object.entries(storage.breakdown).map(([key, bytes]) => (
                  <div key={key} className="text-center">
                    <p className="text-xs font-medium">{formatBytes(bytes)}</p>
                    <p className="text-xs text-muted-foreground capitalize">{key}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <Separator />

      {/* Actions */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">Account actions</h4>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Recovery key</p>
              <p className="text-xs text-muted-foreground">
                View your encrypted recovery key after re-authentication
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowRecoveryKey(true)}
            >
              <Key className="w-4 h-4" />
              View
            </Button>
          </div>
        </div>
      </div>

      <Separator />

      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowSignOutDialog(true)}
          className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-2"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </Button>
        <p className="text-xs text-muted-foreground mt-2">
          Your notes stay on this device. Sync will stop until you sign in again.
        </p>
      </div>

      <RecoveryKeyDialog open={showRecoveryKey} onOpenChange={setShowRecoveryKey} />

      <AlertDialog open={showSignOutDialog} onOpenChange={setShowSignOutDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of sync?</AlertDialogTitle>
            <AlertDialogDescription>
              Sync will stop and encryption keys will be removed from this device. Your notes will
              remain. You&apos;ll need your recovery phrase to set up sync again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signingOut}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {signingOut ? 'Signing out...' : 'Sign out'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
