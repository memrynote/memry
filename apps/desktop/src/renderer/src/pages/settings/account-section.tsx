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
import { CreditCard, ExternalLink, Lock, RefreshCw } from '@/lib/icons'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAuth } from '@/contexts/auth-context'
import { useSync } from '@/contexts/sync-context'
import { useSyncStatus } from '@/hooks/use-sync-status'
import { SetupWizard } from './setup-wizard'
import { QrLinking } from '@/components/sync/qr-linking'
import { LinkingApprovalDialog } from '@/components/sync/linking-approval-dialog'
import { DeviceList } from '@/components/sync/device-list'
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
const BILLING_SUPPORT_EMAIL = 'billing@memrynote.com'

type BillingPlan = 'free' | 'plus' | 'pro' | 'believer'
type BillingStatusValue = 'inactive' | 'active' | 'past_due' | 'paused' | 'canceled'

interface BillingStatus {
  plan: BillingPlan
  status: BillingStatusValue
  email: string | null
  limits: {
    storageLimit: number
    maxFileSize: number
    maxVaults: number | null
    versionHistoryDays: number
  }
  usage: {
    storageUsed: number
  }
  expiresAt: number | null
  canManageBilling: boolean
}

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
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  if (unitIndex === 0) return `${value} ${units[unitIndex]}`
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

function isBillingStatus(value: unknown): value is BillingStatus {
  return Boolean(
    value && typeof value === 'object' && 'plan' in value && 'status' in value && 'limits' in value
  )
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
  const { linkingRequest, clearLinkingRequest, triggerSync } = useSync()
  const syncStatus = useSyncStatus()
  const [storage, setStorage] = useState<StorageBreakdownResult | null>(null)
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [billingError, setBillingError] = useState<string | null>(null)
  const [activationPending, setActivationPending] = useState(false)
  const [showSignOutDialog, setShowSignOutDialog] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [showLinkingQr, setShowLinkingQr] = useState(false)
  const [isBillingRefreshing, setIsBillingRefreshing] = useState(false)
  const [isCheckoutStarting, setIsCheckoutStarting] = useState(false)
  const [isPortalOpening, setIsPortalOpening] = useState(false)
  const billingLoadFailed = t('account.billing.toasts.loadFailed')

  const loadStorage = useCallback(async () => {
    if (state.status !== 'authenticated') return
    try {
      const result = await window.api.syncOps.getStorageBreakdown()
      setStorage(result)
    } catch {
      /* storage is non-critical */
    }
  }, [state.status])

  useEffect(() => {
    void loadStorage()
  }, [loadStorage])

  const loadBilling = useCallback(async () => {
    if (state.status !== 'authenticated') return
    setBillingError(null)
    try {
      const result = await window.api.account.getBillingStatus()
      if (isBillingStatus(result)) {
        setBilling(result)
        setActivationPending(result.plan !== 'free' && result.status !== 'active')
      } else {
        setBillingError(result.error ?? billingLoadFailed)
      }
    } catch (error: unknown) {
      setBillingError(extractErrorMessage(error, billingLoadFailed))
    }
  }, [billingLoadFailed, state.status])

  useEffect(() => {
    void loadBilling()
  }, [loadBilling])

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

  const handleStartCheckout = useCallback(async () => {
    setIsCheckoutStarting(true)
    setActivationPending(true)
    try {
      const result = await window.api.account.startCheckout()
      if (!result.success) {
        setActivationPending(false)
        toast.error(result.error ?? t('account.billing.toasts.checkoutFailed'))
        return
      }
      toast.success(t('account.billing.toasts.checkoutOpened'))
    } catch (error: unknown) {
      setActivationPending(false)
      toast.error(extractErrorMessage(error, t('account.billing.toasts.checkoutFailed')))
    } finally {
      setIsCheckoutStarting(false)
    }
  }, [t])

  const handleRefreshBilling = useCallback(async () => {
    setIsBillingRefreshing(true)
    setBillingError(null)
    try {
      const result = await window.api.account.refreshBillingStatus()
      if (!isBillingStatus(result)) {
        throw new Error(result.error ?? t('account.billing.toasts.refreshFailed'))
      }
      setBilling(result)
      const isActive = result.status === 'active'
      setActivationPending(result.plan !== 'free' && !isActive)
      await loadStorage()
      if (isActive) {
        await triggerSync()
        toast.success(t('account.billing.toasts.billingActive'))
      } else {
        toast.info(t('account.billing.toasts.activationPending'))
      }
    } catch (error: unknown) {
      const message = extractErrorMessage(error, t('account.billing.toasts.refreshFailed'))
      setBillingError(message)
      toast.error(message)
    } finally {
      setIsBillingRefreshing(false)
    }
  }, [loadStorage, t, triggerSync])

  const handleOpenBillingPortal = useCallback(async () => {
    setIsPortalOpening(true)
    try {
      const result = await window.api.account.openBillingPortal()
      if (!result.success) {
        toast.error(result.error ?? t('account.billing.toasts.portalFailed'))
      }
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, t('account.billing.toasts.portalFailed')))
    } finally {
      setIsPortalOpening(false)
    }
  }, [t])

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

  const email = billing?.email ?? state.email
  const initial = (email ?? 'U').charAt(0).toUpperCase()
  const isSyncActive = syncStatus.status !== 'paused'
  const isToggleDisabled = syncStatus.status === 'syncing' || syncStatus.status === 'offline'
  // Free plan (or any unpaid account main gated into `local_only`): sync never
  // connects, so the status row would sit on "Connecting..." forever.
  const isSyncLocked = billing?.plan === 'free' || syncStatus.status === 'local_only'
  const storageCategoryLabels: Record<string, string> = {
    notes: t('account.storage.categories.notes'),
    attachments: t('account.storage.categories.attachments'),
    crdt: t('account.storage.categories.crdt'),
    other: t('account.storage.categories.other')
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('account.header.title')} subtitle={t('account.header.subtitle')} />

      <div className="mb-6 flex items-center gap-3.5 rounded-lg border border-border bg-surface-active px-4 py-3.5">
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
          style={{ backgroundColor: 'var(--tint)' }}
        >
          {initial}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px]/4 font-medium text-foreground">
            {email ?? t('account.identity.unknown')}
          </span>
          <span className="flex items-center gap-1.5 text-xs/4 text-muted-foreground">
            <span className="truncate">
              {billing ? t(`account.billing.plans.${billing.plan}`) : t('account.billing.checking')}
            </span>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <span className="inline-flex shrink-0 items-center gap-1">
              <Lock className="size-3" aria-hidden="true" />
              {t('account.identity.encrypted')}
            </span>
          </span>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background px-2.5 py-1 text-[11px]/4 font-medium text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${syncStatus.dotColor} ${
              syncStatus.isAnimating ? 'motion-safe:animate-pulse' : ''
            }`}
          />
          {syncStatus.label}
        </span>
      </div>

      <SettingsGroup label={t('account.groups.sync')}>
        {isSyncLocked ? (
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-[13px]/4 text-foreground">
                {t('account.sync.upsell.title')}
              </span>
              <span className="text-xs/4 text-muted-foreground">
                {t('account.sync.upsell.description')}
              </span>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleStartCheckout()}
              disabled={isCheckoutStarting}
              className="h-7 shrink-0 px-3 text-xs/4"
            >
              {isCheckoutStarting
                ? t('account.billing.actions.opening')
                : t('account.billing.actions.unlockSync')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between h-11 px-4 shrink-0">
            <div className="flex items-center gap-2">
              <div
                className={`size-2 shrink-0 rounded-full ${syncStatus.dotColor} ${
                  syncStatus.isAnimating ? 'motion-safe:animate-pulse' : ''
                }`}
              />
              <div className="flex flex-col gap-px">
                <span className="font-medium text-[13px]/4 text-foreground">
                  {syncStatus.label}
                </span>
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
              onCheckedChange={(checked) =>
                void (checked ? syncStatus.resume() : syncStatus.pause())
              }
              className={ACCENT_SWITCH}
            />
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup label={t('account.groups.billing')}>
        <div className="space-y-3 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <CreditCard className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="font-medium text-[13px]/4 text-foreground">
                  {billing
                    ? t(`account.billing.plans.${billing.plan}`)
                    : t('account.billing.planStatus')}
                </div>
                <div className="text-xs/4 text-muted-foreground">
                  {billing
                    ? t(`account.billing.statuses.${billing.status}`)
                    : t('account.billing.checking')}
                </div>
              </div>
            </div>
            {billing && (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px]/4 font-medium ${
                  billing.status === 'active'
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                }`}
              >
                {t(`account.billing.statuses.${billing.status}`)}
              </span>
            )}
          </div>

          {storage && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs/4 text-muted-foreground">
                  {t('account.billing.labels.storage')}
                </span>
                <span className="text-[13px]/4 font-medium text-foreground">
                  {t('account.storage.used', {
                    used: formatBytes(storage.used),
                    limit: formatBytes(storage.limit)
                  })}
                </span>
              </div>
              <div className="flex h-2 overflow-hidden rounded-full bg-muted">
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
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {Object.entries(storage.breakdown).map(([key]) => (
                  <div key={key} className="flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c' }}
                    />
                    <span className="text-xs/4 text-muted-foreground">
                      {storageCategoryLabels[key] ?? key}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {billing && (
            <div className="grid gap-2 text-xs/4 text-muted-foreground sm:grid-cols-3">
              <div>
                <span className="font-medium text-foreground">
                  {t('account.billing.labels.maxFile')}
                </span>{' '}
                {formatBytes(billing.limits.maxFileSize)}
              </div>
              <div>
                <span className="font-medium text-foreground">
                  {t('account.billing.labels.vaults')}
                </span>{' '}
                {billing.limits.maxVaults ?? t('account.billing.unlimited')}
              </div>
              <div>
                <span className="font-medium text-foreground">
                  {t('account.billing.labels.history')}
                </span>{' '}
                {t('account.billing.historyDays', {
                  days: billing.limits.versionHistoryDays
                })}
              </div>
            </div>
          )}

          {(activationPending || billingError) && (
            <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs/4 text-amber-900 dark:text-amber-200">
              {billingError ?? (
                <>
                  {t('account.billing.activationPendingPrefix')}{' '}
                  <a
                    className="font-medium underline underline-offset-2"
                    href={`mailto:${BILLING_SUPPORT_EMAIL}`}
                  >
                    {BILLING_SUPPORT_EMAIL}
                  </a>
                  .
                </>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleStartCheckout()}
              disabled={isCheckoutStarting || billing?.status === 'active'}
              className="h-7 px-3 text-xs/4"
            >
              {isCheckoutStarting
                ? t('account.billing.actions.opening')
                : isSyncLocked
                  ? t('account.billing.actions.unlockSync')
                  : t('account.billing.actions.upgrade')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRefreshBilling()}
              disabled={isBillingRefreshing}
              className="h-7 px-3 text-xs/4"
            >
              <RefreshCw
                className={`me-1.5 size-3.5 ${isBillingRefreshing ? 'animate-spin' : ''}`}
              />
              {t('account.billing.actions.refresh')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleOpenBillingPortal()}
              disabled={isPortalOpening || !billing?.canManageBilling}
              className="h-7 px-3 text-xs/4"
            >
              <ExternalLink className="me-1.5 size-3.5" />
              {t('account.billing.actions.manage')}
            </Button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup label={t('account.groups.devices')}>
        <DeviceList onLinkDevice={() => setShowLinkingQr(true)} />
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
