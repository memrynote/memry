import { useState, useEffect, useCallback } from 'react'
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
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { RefreshCw } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAuth } from '@/contexts/auth-context'
import { useSync } from '@/contexts/sync-context'
import { useSyncStatus } from '@/hooks/use-sync-status'
import { SetupWizard } from './setup-wizard'
import { QrLinking } from '@/components/sync/qr-linking'
import { LinkingApprovalDialog } from '@/components/sync/linking-approval-dialog'
import { DeviceList } from '@/components/sync/device-list'
import { KeyRotationWizard } from '@/components/sync/key-rotation-wizard'
import { RecoveryKeyDialog } from '@/components/settings/recovery-key-dialog'
import type { StorageBreakdownResult } from '@memry/contracts/ipc-sync-ops'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'
import { invoke } from '@/lib/ipc/invoke'

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
  const { linkingRequest, clearLinkingRequest } = useSync()
  const syncStatus = useSyncStatus()
  const [storage, setStorage] = useState<StorageBreakdownResult | null>(null)
  const [showSignOutDialog, setShowSignOutDialog] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [showLinkingQr, setShowLinkingQr] = useState(false)
  const [showRotationWizard, setShowRotationWizard] = useState(false)
  const [showRecoveryKey, setShowRecoveryKey] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const loadStorage = useCallback(async () => {
    if (state.status !== 'authenticated') return
    setIsRefreshing(true)
    try {
      const result = await invoke<StorageBreakdownResult | null>(
        'sync_ops_get_storage_breakdown'
      )
      setStorage(result)
    } catch {
      /* storage is non-critical */
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

  if (state.status === 'checking') {
    return (
      <div className="flex flex-col">
        <SettingsHeader title="Account" subtitle="Loading..." />
      </div>
    )
  }

  if (state.status !== 'authenticated') {
    return (
      <div className="flex flex-col items-center text-xs/4">
        <div className="w-full max-w-sm">
          <SetupWizard />
        </div>
      </div>
    )
  }

  const email = state.email
  const initial = (email ?? 'U').charAt(0).toUpperCase()
  const isSyncActive = syncStatus.status !== 'paused'
  const isToggleDisabled = syncStatus.status === 'syncing' || syncStatus.status === 'offline'

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title="Account" subtitle="Your account, sync, and security" />

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
            <span className="text-xs/4 text-muted-foreground">Pro plan</span>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup label="Sync">
        <div className="flex items-center justify-between h-11 px-4 shrink-0">
          <div className="flex items-center gap-2">
            <div className={`shrink-0 rounded-sm size-2 ${syncStatus.dotColor}`} />
            <div className="flex flex-col gap-px">
              <span className="font-medium text-[13px]/4 text-foreground">{syncStatus.label}</span>
              <span className="text-xs/4 text-muted-foreground">
                Last synced {syncStatus.lastSyncLabel}
                {syncStatus.pendingCount > 0 && ` · ${syncStatus.pendingCount} pending`}
              </span>
            </div>
          </div>
          <Switch
            checked={isSyncActive}
            disabled={isToggleDisabled}
            onCheckedChange={(checked) => void (checked ? syncStatus.resume() : syncStatus.pause())}
            className={ACCENT_SWITCH}
          />
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

      <SettingsGroup label="Devices">
        <DeviceList onLinkDevice={() => setShowLinkingQr(true)} />
      </SettingsGroup>

      <SettingsGroup label="Security">
        <SettingRow label="Recovery Key" description="View your recovery key for data access">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRecoveryKey(true)}
            className="h-7 px-3 text-xs/4"
          >
            View Key
          </Button>
        </SettingRow>

        <SettingRow
          label="Rotate Encryption Keys"
          description="Generate new keys and re-encrypt all data"
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRotationWizard(true)}
            className="h-7 px-3 text-xs/4"
          >
            Rotate
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingRow label="Sign Out" description="Disconnect this device from sync">
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

      <AlertDialog open={showSignOutDialog} onOpenChange={setShowSignOutDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of sync?</AlertDialogTitle>
            <AlertDialogDescription>
              Sync will stop and encryption keys will be removed from this device. Your notes will
              remain on this device. You&apos;ll need your recovery phrase to set up sync again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signingOut}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSignOut}
              disabled={signingOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {signingOut ? 'Signing out...' : 'Sign out'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <KeyRotationWizard open={showRotationWizard} onOpenChange={setShowRotationWizard} />
      <RecoveryKeyDialog open={showRecoveryKey} onOpenChange={setShowRecoveryKey} />

      <Dialog open={showLinkingQr} onOpenChange={setShowLinkingQr}>
        <DialogContent className="sm:max-w-[400px] rounded-xl">
          <QrLinking onCancel={() => setShowLinkingQr(false)} />
        </DialogContent>
      </Dialog>

      <LinkingApprovalDialog
        open={!!linkingRequest}
        event={linkingRequest}
        onApprove={() => {
          clearLinkingRequest()
          toast.success('Device linked successfully')
        }}
        onReject={clearLinkingRequest}
      />
    </div>
  )
}
