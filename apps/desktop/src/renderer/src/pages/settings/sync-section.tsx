import { useState, useCallback, useEffect } from 'react'
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
import { CloudOff, RefreshCw, Pause, Play, LogOut, QrCode, RotateCw } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAuth } from '@/contexts/auth-context'
import { useSync } from '@/contexts/sync-context'
import { useSyncStatus } from '@/hooks/use-sync-status'
import { SetupWizard } from './setup-wizard'
import { QrLinking } from '@/components/sync/qr-linking'
import { LinkingApprovalDialog } from '@/components/sync/linking-approval-dialog'
import { SyncHistoryPanel } from '@/components/sync/sync-history'
import { DeviceList } from '@/components/sync/device-list'
import { KeyRotationWizard } from '@/components/sync/key-rotation-wizard'

export function SyncSettings() {
  const { state, logout, setWizardStep } = useAuth()
  const { linkingRequest, clearLinkingRequest } = useSync()
  const syncStatus = useSyncStatus()
  const [showSignOutDialog, setShowSignOutDialog] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [showLinkingQr, setShowLinkingQr] = useState(false)
  const [showRotationWizard, setShowRotationWizard] = useState(false)

  useEffect(() => {
    if (state.status === 'unauthenticated' && state.wizardStep === 'idle') {
      setWizardStep('sign-in')
    }
  }, [state.status, state.wizardStep, setWizardStep])

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

  const isSyncBusy = syncStatus.status === 'syncing' || syncStatus.status === 'offline'

  if (state.status === 'checking') {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Sync</h3>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (state.status === 'authenticated') {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">Sync</h3>
          <p className="text-sm text-muted-foreground">End-to-end encrypted</p>
        </div>
        <Separator />

        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10">
              <syncStatus.IconComponent className="w-4 h-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${syncStatus.dotColor}`} />
                <p className="text-sm font-medium">
                  {syncStatus.label}
                  <span className="text-muted-foreground font-normal">
                    {' · '}Last synced {syncStatus.lastSyncLabel}
                    {syncStatus.pendingCount > 0 && ` · ${syncStatus.pendingCount} pending`}
                  </span>
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Signed in{state.email ? ` as ${state.email}` : ''}
              </p>
            </div>
          </div>

          {showLinkingQr ? (
            <QrLinking onCancel={() => setShowLinkingQr(false)} />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isSyncBusy}
                onClick={() => void syncStatus.triggerSync()}
                className="gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                {syncStatus.status === 'syncing'
                  ? 'Syncing...'
                  : syncStatus.status === 'idle' && syncStatus.pendingCount > 0
                    ? `Sync ${syncStatus.pendingCount} ${syncStatus.pendingCount === 1 ? 'change' : 'changes'}`
                    : 'Sync Now'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void (syncStatus.status === 'paused' ? syncStatus.resume() : syncStatus.pause())
                }
                className="gap-2"
              >
                {syncStatus.status === 'paused' ? (
                  <>
                    <Play className="w-4 h-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="w-4 h-4" />
                    Pause
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowLinkingQr(true)}
                className="gap-2"
              >
                <QrCode className="w-4 h-4" />
                Link Device
              </Button>
            </div>
          )}
        </div>

        <Separator />

        <div className="space-y-3">
          <h4 className="text-sm font-medium">Devices</h4>
          <DeviceList />
        </div>

        <Separator />

        <div className="space-y-3">
          <h4 className="text-sm font-medium">Security</h4>
          <p className="text-xs text-muted-foreground">
            Rotate encryption keys to generate a new recovery phrase. Your data stays intact.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRotationWizard(true)}
            className="gap-2"
          >
            <RotateCw className="w-4 h-4" />
            Rotate Encryption Keys
          </Button>
        </div>

        <KeyRotationWizard open={showRotationWizard} onOpenChange={setShowRotationWizard} />

        <Separator />

        <SyncHistoryPanel />

        <Separator />

        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSignOutDialog(true)}
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sign out
          </Button>
          <p className="text-xs text-muted-foreground mt-2">
            Your notes stay on this device. Sync will stop until you sign in again.
          </p>
        </div>

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
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Sync</h3>
        <p className="text-sm text-muted-foreground">
          Sync your data across devices with end-to-end encryption
        </p>
      </div>
      <Separator />
      <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted">
          <CloudOff className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Sync disabled</p>
          <p className="text-xs text-muted-foreground">Your notes are only stored on this device</p>
        </div>
      </div>
      <SetupWizard />
    </div>
  )
}
