import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
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
import { RefreshCw } from '@/lib/icons'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAuth } from '@/contexts/auth-context'
import { useAccountInfo } from '@/hooks/use-account-info'
import { RecoveryKeyDialog } from '@/components/settings/recovery-key-dialog'
import type { StorageBreakdownResult } from '@memry/contracts/ipc-sync-ops'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow
} from '@/components/settings/settings-primitives'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const STORAGE_COLORS: Record<string, string> = {
  notes: '#6366f1',
  attachments: '#f97316',
  crdt: '#22c55e',
  other: '#8c8c8c'
}

export function AccountSettings() {
  const { state, logout } = useAuth()
  const { accountInfo, isLoading: infoLoading } = useAccountInfo()
  const [storage, setStorage] = useState<StorageBreakdownResult | null>(null)
  const [showSignOutDialog, setShowSignOutDialog] = useState(false)
  const [showRecoveryKey, setShowRecoveryKey] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const loadStorage = useCallback(async () => {
    if (state.status !== 'authenticated') return
    setIsRefreshing(true)
    try {
      const result = await window.api.syncOps.getStorageBreakdown()
      setStorage(result)
    } catch {
      /* ignore */
    } finally {
      setIsRefreshing(false)
    }
  }, [state.status])

  useEffect(() => {
    loadStorage()
  }, [loadStorage])

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
      <div className="flex flex-col antialiased">
        <SettingsHeader title="Account" subtitle="Loading..." />
      </div>
    )
  }

  if (state.status !== 'authenticated') {
    return (
      <div className="flex flex-col antialiased text-xs/4">
        <SettingsHeader title="Account" subtitle="Not signed in" />
        <p className="text-xs/4 text-muted-foreground">
          Sign in via the Sync section to access account settings.
        </p>
      </div>
    )
  }

  const email = accountInfo?.email ?? state.email
  const joinedAt = accountInfo?.joinedAt
  const initial = (email ?? 'U').charAt(0).toUpperCase()

  const storageUsedPct =
    storage && storage.limit > 0 ? Math.min(100, (storage.used / storage.limit) * 100) : null

  return (
    <div className="flex flex-col antialiased text-xs/4">
      <SettingsHeader title="Account" subtitle="Manage your account and data" />

      <SettingsGroup label="Identity">
        <div className="flex items-center gap-3 h-14 py-3 px-4">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white text-sm font-semibold"
            style={{ backgroundColor: 'var(--tint)' }}
          >
            {initial}
          </div>
          <div className="flex flex-col gap-px min-w-0">
            <span className="font-medium text-[13px]/4 text-foreground truncate">
              {email ?? 'Unknown'}
            </span>
            {joinedAt && (
              <span className="text-xs/4 text-muted-foreground">
                Member since {format(new Date(joinedAt), 'MMMM yyyy')}
              </span>
            )}
          </div>
        </div>
      </SettingsGroup>

      {storage && (
        <SettingsGroup label="Storage">
          <div className="py-3 px-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[13px]/4 text-foreground">
                {formatBytes(storage.used)} of {formatBytes(storage.limit)} used
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadStorage()}
                disabled={isRefreshing}
                className="h-7 w-7 p-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            <div className="h-2 rounded-full bg-muted overflow-hidden flex">
              {Object.entries(storage.breakdown).map(([key, bytes]) => {
                const pct = storage.limit > 0 ? (bytes / storage.limit) * 100 : 0
                return (
                  <div
                    key={key}
                    className="h-full first:rounded-l-full last:rounded-r-full"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c'
                    }}
                  />
                )
              })}
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              {Object.entries(storage.breakdown).map(([key, bytes]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c' }}
                  />
                  <span className="text-xs/4 text-muted-foreground capitalize">{key}</span>
                </div>
              ))}
            </div>
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup label="Account Actions">
        <SettingRow label="Recovery Key" description="View your encrypted recovery key">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRecoveryKey(true)}
            className="h-7 px-3 text-xs/4"
          >
            View
          </Button>
        </SettingRow>

        <SettingRow label="Sign Out" description="Notes stay on this device. Sync stops.">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSignOutDialog(true)}
            className="h-7 px-3 text-xs/4 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            Sign Out
          </Button>
        </SettingRow>
      </SettingsGroup>

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
