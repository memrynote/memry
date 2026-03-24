import { useState, useCallback } from 'react'
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
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'

export function SyncSettings() {
  const { state, logout } = useAuth()
  const { linkingRequest, clearLinkingRequest } = useSync()
  const syncStatus = useSyncStatus()
  const [showSignOutDialog, setShowSignOutDialog] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [showLinkingQr, setShowLinkingQr] = useState(false)
  const [showRotationWizard, setShowRotationWizard] = useState(false)
  const [showRecoveryKey, setShowRecoveryKey] = useState(false)

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

  const isSyncActive = syncStatus.status !== 'paused'
  const isToggleDisabled = syncStatus.status === 'syncing' || syncStatus.status === 'offline'

  if (state.status === 'checking') {
    return (
      <div className="flex flex-col antialiased">
        <SettingsHeader title="Sync" subtitle="Loading..." />
      </div>
    )
  }

  if (state.status === 'authenticated') {
    return (
      <div className="flex flex-col antialiased text-xs/4">
        <SettingsHeader title="Sync" subtitle="End-to-end encrypted sync across your devices" />

        <SettingsGroup label="Status">
          <div className="flex items-center justify-between h-11 px-4 shrink-0">
            <div className="flex items-center gap-2">
              <div className={`shrink-0 rounded-sm size-2 ${syncStatus.dotColor}`} />
              <div className="flex flex-col gap-px">
                <span className="font-medium text-[13px]/4 text-foreground">
                  {syncStatus.label}
                </span>
                <span className="text-xs/4 text-muted-foreground">
                  Last synced {syncStatus.lastSyncLabel}
                  {syncStatus.pendingCount > 0 && ` · ${syncStatus.pendingCount} pending`}
                </span>
              </div>
            </div>
            <Switch
              checked={isSyncActive}
              disabled={isToggleDisabled}
              onCheckedChange={(checked) =>
                void (checked ? syncStatus.resume() : syncStatus.pause())
              }
              className={ACCENT_SWITCH}
            />
          </div>

          <SettingRow label="Account" description={state.email ?? 'Unknown'}>
            <span className="text-xs/4 text-muted-foreground">Pro plan</span>
          </SettingRow>
        </SettingsGroup>

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

  return (
    <div className="flex flex-col items-center antialiased text-xs/4">
      <div className="w-full max-w-sm">
        <SetupWizard />
      </div>
    </div>
  )
}
