import { useState, useEffect, useCallback } from 'react'
import { useT } from '@memry/i18n/renderer'
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

const MEMRY_REPOSITORY_URL = 'https://github.com/memrynote/memry'
const MEMRY_ISSUES_URL =
  'https://github.com/memrynote/memry/issues?q=sort%3Aupdated-desc+is%3Aissue+is%3Aopen+'
const MEMRY_ICON_SRC = new URL('../../../../../build/icon.png', import.meta.url).href

function AccountCommunityFooter() {
  const { t } = useT('settings')

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 px-4 pb-2 text-center text-xs/4 text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {t('account.community.prompt')}
        <img
          src={MEMRY_ICON_SRC}
          alt=""
          aria-hidden="true"
          className="size-4 shrink-0 rounded-[4px]"
        />
      </span>
      <a
        href={MEMRY_REPOSITORY_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-[var(--tint)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {t('account.community.star')}
      </a>
      <span>{t('account.community.and')}</span>
      <a
        href={MEMRY_ISSUES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-[var(--tint)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {t('account.community.feedback')}
      </a>
      <span>.</span>
    </div>
  )
}

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
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
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
      const result = await window.api.syncOps.getStorageBreakdown()
      setStorage(result)
    } catch {
      /* storage is non-critical */
    } finally {
      setIsRefreshing(false)
    }
  }, [state.status])

  useEffect(() => {
    void loadStorage()
  }, [loadStorage])

  const handleSignOut = useCallback(async () => {
    setSigningOut(true)
    try {
      await logout()
      toast.success(t('account.toasts.signedOut'))
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('account.toasts.signOutFailed')))
    } finally {
      setSigningOut(false)
      setShowSignOutDialog(false)
    }
  }, [logout, t])

  if (state.status === 'checking') {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('account.header.title')} subtitle={t('account.header.loading')} />
      </div>
    )
  }

  if (state.status !== 'authenticated') {
    return (
      <div className="flex min-h-[calc(80vh-3rem)] flex-col items-center justify-between text-xs/4">
        <div className="w-full max-w-sm">
          <SetupWizard />
        </div>
        <AccountCommunityFooter />
      </div>
    )
  }

  const email = state.email
  const initial = (email ?? 'U').charAt(0).toUpperCase()
  const isSyncActive = syncStatus.status !== 'paused'
  const isToggleDisabled = syncStatus.status === 'syncing' || syncStatus.status === 'offline'
  const storageCategoryLabels: Record<string, string> = {
    notes: t('account.storage.categories.notes'),
    attachments: t('account.storage.categories.attachments'),
    crdt: t('account.storage.categories.crdt'),
    other: t('account.storage.categories.other')
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('account.header.title')} subtitle={t('account.header.subtitle')} />

      <SettingsGroup label={t('account.groups.identity')}>
        <div className="flex items-center gap-3 h-14 py-3 px-4">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-white text-sm font-semibold"
            style={{ backgroundColor: 'var(--tint)' }}
          >
            {initial}
          </div>
          <div className="flex flex-col gap-px min-w-0">
            <span className="font-medium text-[13px]/4 text-foreground truncate">
              {email ?? t('account.identity.unknown')}
            </span>
            <span className="text-xs/4 text-muted-foreground">{t('account.identity.plan')}</span>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup label={t('account.groups.sync')}>
        <div className="flex items-center justify-between h-11 px-4 shrink-0">
          <div className="flex items-center gap-2">
            <div className={`shrink-0 rounded-sm size-2 ${syncStatus.dotColor}`} />
            <div className="flex flex-col gap-px">
              <span className="font-medium text-[13px]/4 text-foreground">{syncStatus.label}</span>
              <span className="text-xs/4 text-muted-foreground">
                {t('account.sync.lastSynced', { time: syncStatus.lastSyncLabel })}
                {syncStatus.pendingCount > 0 &&
                  ` · ${t('account.sync.pending', { count: syncStatus.pendingCount })}`}
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
        <SettingsGroup label={t('account.groups.storage')}>
          <div className="py-3 px-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[13px]/4 text-foreground">
                {t('account.storage.used', {
                  used: formatBytes(storage.used),
                  limit: formatBytes(storage.limit)
                })}
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
                    className="h-full first:rounded-s-full last:rounded-e-full"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c'
                    }}
                  />
                )
              })}
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              {Object.entries(storage.breakdown).map(([key, _bytes]) => (
                <div key={key} className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c' }}
                  />
                  <span className="text-xs/4 text-muted-foreground">
                    {storageCategoryLabels[key] ?? key}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup label={t('account.groups.devices')}>
        <DeviceList onLinkDevice={() => setShowLinkingQr(true)} />
      </SettingsGroup>

      <SettingsGroup label={t('account.groups.security')}>
        <SettingRow
          label={t('account.security.recoveryKey.label')}
          description={t('account.security.recoveryKey.description')}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRecoveryKey(true)}
            className="h-7 px-3 text-xs/4"
          >
            {t('account.security.recoveryKey.action')}
          </Button>
        </SettingRow>

        <SettingRow
          label={t('account.security.rotateKeys.label')}
          description={t('account.security.rotateKeys.description')}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowRotationWizard(true)}
            className="h-7 px-3 text-xs/4"
          >
            {t('account.security.rotateKeys.action')}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingRow
          label={t('account.security.signOut.label')}
          description={t('account.security.signOut.description')}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSignOutDialog(true)}
            className="h-7 px-3 text-xs/4 text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            {t('account.security.signOut.action')}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <AccountCommunityFooter />

      <AlertDialog open={showSignOutDialog} onOpenChange={setShowSignOutDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('account.signOutDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('account.signOutDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signingOut}>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {signingOut
                ? t('account.signOutDialog.signingOut')
                : t('account.signOutDialog.confirm')}
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
          toast.success(t('account.toasts.deviceLinked'))
        }}
        onReject={clearLinkingRequest}
      />
    </div>
  )
}
