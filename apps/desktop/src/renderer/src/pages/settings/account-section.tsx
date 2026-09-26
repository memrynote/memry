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
import { Check, ExternalLink, Lock, RefreshCw, Sparkles } from '@/lib/icons'
import { cn } from '@/lib/utils'
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
  ACCENT_SWITCH,
  SETTINGS_GROUP_LABEL
} from '@/components/settings/settings-primitives'

const MEMRY_REPOSITORY_URL = 'https://github.com/memrynote/memry'
const MEMRY_ISSUES_URL =
  'https://github.com/memrynote/memry/issues?q=sort%3Aupdated-desc+is%3Aissue+is%3Aopen+'
const MEMRY_ICON_SRC = new URL('../../../../../build/icon.png', import.meta.url).href
const BILLING_SUPPORT_EMAIL = 'billing@memrynote.com'

type BillingPlan = 'free' | 'plus' | 'pro' | 'believer'
type BillingStatusValue = 'inactive' | 'active' | 'past_due' | 'paused' | 'canceled'

type BillingCadence = 'monthly' | 'annual' | 'lifetime'

interface PlanChangePreview {
  isUpgrade: boolean
  effective: 'immediate' | 'next_billing_period'
  immediateChargeAmount: string | null
  recurringAmount: string
  currencyCode: string
  nextBilledAt: string | null
}

/** Paddle reports money in minor units; `"4349"` is $43.49. */
function formatMinorUnits(amount: string): string {
  const value = Number(amount) / 100
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : amount
}

function isPlanChangePreview(value: unknown): value is PlanChangePreview {
  return Boolean(value && typeof value === 'object' && 'recurringAmount' in value)
}

interface BillingStatus {
  plan: BillingPlan
  cadence: BillingCadence | null
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
    <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 pt-6 text-center text-xs/4 text-muted-foreground">
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

/**
 * Offers a monthly subscriber the yearly switch. First click prices it through Paddle's preview,
 * second confirms. Switching cadence must go through change-plan, not a fresh checkout: a second
 * checkout would create a parallel subscription in Paddle and bill the card twice.
 */
function AnnualSwitchRow({
  plan,
  onSwitched
}: {
  plan: 'plus' | 'pro'
  onSwitched: (billing: BillingStatus) => void
}) {
  const { t } = useT('settings')
  const [preview, setPreview] = useState<PlanChangePreview | null>(null)
  const [isPricing, setIsPricing] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const failed = t('account.billing.annualSwitch.failed')

  const run = async () => {
    if (!preview) {
      setIsPricing(true)
      try {
        const result = await window.api.account.previewPlanChange({ plan, cadence: 'annual' })
        if (!isPlanChangePreview(result)) throw new Error(result.error ?? failed)
        setPreview(result)
      } catch (error: unknown) {
        toast.error(extractErrorMessage(error, failed))
      } finally {
        setIsPricing(false)
      }
      return
    }

    setIsSwitching(true)
    try {
      const result = await window.api.account.changePlan({ plan, cadence: 'annual' })
      if (!isBillingStatus(result)) throw new Error(result.error ?? failed)
      onSwitched(result)
      setPreview(null)
      toast.success(t('account.billing.annualSwitch.success'))
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error, failed))
    } finally {
      setIsSwitching(false)
    }
  }

  const label = isSwitching ? 'switching' : isPricing ? 'pricing' : preview ? 'confirm' : 'action'

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px]/4 text-foreground">
            {t('account.billing.annualSwitch.title')}
          </div>
          <div className="mt-0.5 text-xs/4 text-muted-foreground">
            {preview
              ? t('account.billing.annualSwitch.preview', {
                  amount: formatMinorUnits(preview.immediateChargeAmount ?? '0'),
                  recurring: formatMinorUnits(preview.recurringAmount)
                })
              : t('account.billing.annualSwitch.description')}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-3 text-xs/4"
          disabled={isPricing || isSwitching}
          onClick={() => void run()}
        >
          {t(`account.billing.annualSwitch.${label}`)}
        </Button>
      </div>
    </div>
  )
}

/**
 * What the Sync group shows to an account that cannot sync yet.
 *
 * Two audiences, one card. Without a plan it sells: what sync gives you, the
 * guarantee, one CTA. With a plan that is ACTIVE but still gated it must not
 * sell at all — the money is paid and the entitlement simply has not reached
 * sync yet (#2201), so it offers a refresh instead of a second checkout.
 */
function SyncUpgradeCard({
  billingStatus,
  isCheckoutStarting,
  isBillingRefreshing,
  onStartCheckout,
  onRefreshBilling
}: {
  billingStatus: BillingStatusValue | undefined
  isCheckoutStarting: boolean
  isBillingRefreshing: boolean
  onStartCheckout: () => void
  onRefreshBilling: () => void
}) {
  const { t } = useT('settings')
  const isActivating = billingStatus === 'active'
  const benefits = [
    t('account.sync.upsell.benefits.devices'),
    t('account.sync.upsell.benefits.encrypted'),
    t('account.sync.upsell.benefits.backup')
  ]

  return (
    <div className="space-y-3 py-3.5">
      <div className="flex items-start gap-3">
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: 'color-mix(in srgb, var(--tint) 12%, transparent)' }}
        >
          <Sparkles className="size-4" style={{ color: 'var(--tint)' }} aria-hidden="true" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="font-medium text-[13px]/4 text-foreground">
            {t(isActivating ? 'account.sync.activating.title' : 'account.sync.upsell.title')}
          </div>
          <div className="text-xs/4 text-muted-foreground">
            {t(
              isActivating
                ? 'account.sync.activating.description'
                : 'account.sync.upsell.description'
            )}
          </div>
        </div>
      </div>

      {isActivating ? (
        <div className="ps-11">
          <Button
            variant="default"
            size="sm"
            onClick={onRefreshBilling}
            disabled={isBillingRefreshing}
            className="h-7 shrink-0 px-3 text-xs/4"
          >
            <RefreshCw className={`me-1.5 size-3.5 ${isBillingRefreshing ? 'animate-spin' : ''}`} />
            {t('account.billing.actions.refresh')}
          </Button>
        </div>
      ) : (
        <>
          <ul className="grid gap-1.5 ps-11">
            {benefits.map((benefit) => (
              <li key={benefit} className="flex items-start gap-2 text-xs/4 text-foreground">
                <Check
                  className="mt-px size-3.5 shrink-0"
                  style={{ color: 'var(--tint)' }}
                  aria-hidden="true"
                />
                {benefit}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 ps-11">
            <Button
              variant="default"
              size="sm"
              onClick={onStartCheckout}
              disabled={isCheckoutStarting}
              className="h-7 shrink-0 px-3 text-xs/4"
            >
              {isCheckoutStarting
                ? t('account.billing.actions.opening')
                : t('account.billing.actions.unlockSync')}
            </Button>
            <span className="text-[11px]/4 text-muted-foreground">
              {t('account.sync.upsell.guarantee')}
            </span>
          </div>
        </>
      )}
    </div>
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
  const [attachmentAutoDownload, setAttachmentAutoDownload] = useState(true)
  const billingLoadFailed = t('account.billing.toasts.loadFailed')

  useEffect(() => {
    void window.api.settings
      .getSyncSettings()
      // Explicit !== false: blobs written by older versions have no key and
      // must read as "on" (the shipped default).
      .then((settings) => setAttachmentAutoDownload(settings.attachmentAutoDownload !== false))
      .catch(() => {
        /* keep the default-on optimistic value */
      })
  }, [])

  const handleAttachmentAutoDownloadChange = useCallback(
    (checked: boolean) => {
      setAttachmentAutoDownload(checked)
      void window.api.settings.setSyncSettings({ attachmentAutoDownload: checked }).catch(() => {
        setAttachmentAutoDownload(!checked)
        toast.error(t('account.sync.attachmentAutoDownload.saveFailed'))
      })
    },
    [t]
  )

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

      <div className="flex items-center gap-3 pb-6">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold text-white"
          style={{ backgroundColor: 'var(--tint)' }}
        >
          {initial}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px]/5 font-semibold text-foreground">
            {email ?? t('account.identity.unknown')}
          </span>
          <span className="inline-flex items-center gap-1 text-xs/4 text-muted-foreground">
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            {t('account.identity.encrypted')}
          </span>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px]/4 font-medium text-muted-foreground">
          {billing ? t(`account.billing.plans.${billing.plan}`) : t('account.billing.checking')}
        </span>
      </div>

      <div
        className="mb-8 grid grid-cols-3 border-y border-border"
        data-testid="account-stats-strip"
      >
        <div className="flex min-w-0 flex-col gap-1 py-3 pe-4">
          <span className="text-xs/4 text-muted-foreground">{t('account.groups.sync')}</span>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px]/4 text-foreground">
            <span
              className={`size-1.5 shrink-0 rounded-full ${syncStatus.dotColor} ${
                syncStatus.isAnimating ? 'motion-safe:animate-pulse' : ''
              }`}
            />
            <span className="truncate">{syncStatus.label}</span>
          </span>
          <span className="truncate text-xs/4 text-muted-foreground">
            {t('account.sync.lastSynced', { time: syncStatus.lastSyncLabel })}
          </span>
        </div>

        <div className="flex min-w-0 flex-col gap-1 border-s border-border py-3 px-4">
          <span className="text-xs/4 text-muted-foreground">
            {t('account.billing.labels.storage')}
          </span>
          {storage ? (
            <>
              <span className="truncate text-[13px]/4 text-foreground tabular-nums">
                {t('account.storage.used', {
                  used: formatBytes(storage.used),
                  limit: formatBytes(storage.limit)
                })}
              </span>
              <div className="mt-1 flex h-1 overflow-hidden rounded-full bg-muted">
                {Object.entries(storage.breakdown).map(([key, bytes]) => {
                  const pct = storage.limit > 0 ? (bytes / storage.limit) * 100 : 0
                  return (
                    <div
                      key={key}
                      title={`${storageCategoryLabels[key] ?? key} · ${formatBytes(bytes)}`}
                      className="h-full"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: STORAGE_COLORS[key] ?? '#8c8c8c'
                      }}
                    />
                  )
                })}
              </div>
            </>
          ) : (
            <span className="text-[13px]/4 text-muted-foreground">—</span>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-1 border-s border-border py-3 ps-4">
          <span className="text-xs/4 text-muted-foreground">{t('account.v2.stats.plan')}</span>
          <span className="truncate text-[13px]/4 text-foreground">
            {billing ? t(`account.billing.plans.${billing.plan}`) : t('account.billing.planStatus')}
          </span>
          <span className="truncate text-xs/4 text-muted-foreground">
            {billing
              ? t(`account.billing.statuses.${billing.status}`)
              : t('account.billing.checking')}
          </span>
        </div>
      </div>

      <div className="flex flex-col pb-8">
        <div className="flex items-end justify-between gap-3 pb-1.5">
          <h4 className={cn(SETTINGS_GROUP_LABEL, 'pb-0')}>{t('account.groups.devices')}</h4>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowLinkingQr(true)}
            className="h-6 px-2 text-xs/4"
          >
            {t('devices.linkNew')}
          </Button>
        </div>
        <DeviceList />
      </div>

      <SettingsGroup label={t('account.groups.sync')}>
        {isSyncLocked ? (
          <SyncUpgradeCard
            billingStatus={billing?.status}
            isCheckoutStarting={isCheckoutStarting}
            isBillingRefreshing={isBillingRefreshing}
            onStartCheckout={() => void handleStartCheckout()}
            onRefreshBilling={() => void handleRefreshBilling()}
          />
        ) : (
          <SettingRow
            label={syncStatus.label}
            description={`${t('account.sync.lastSynced', { time: syncStatus.lastSyncLabel })}${
              syncStatus.pendingCount > 0
                ? ` · ${t('account.sync.pending', { count: syncStatus.pendingCount })}`
                : ''
            }`}
          >
            <Switch
              checked={isSyncActive}
              disabled={isToggleDisabled}
              onCheckedChange={(checked) =>
                void (checked ? syncStatus.resume() : syncStatus.pause())
              }
              className={ACCENT_SWITCH}
            />
          </SettingRow>
        )}
        {!isSyncLocked && (
          <SettingRow
            label={t('account.sync.attachmentAutoDownload.label')}
            description={t('account.sync.attachmentAutoDownload.description')}
          >
            <Switch
              checked={attachmentAutoDownload}
              onCheckedChange={handleAttachmentAutoDownloadChange}
              className={ACCENT_SWITCH}
            />
          </SettingRow>
        )}
      </SettingsGroup>

      <SettingsGroup label={t('account.groups.billing')}>
        <div className="flex min-h-14 items-center justify-between gap-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="inline-flex items-center gap-1.5 text-[13px]/4 text-foreground">
              {billing
                ? t(`account.billing.plans.${billing.plan}`)
                : t('account.billing.planStatus')}
              {billing && (
                <span className="inline-flex items-center gap-1 text-xs/4 text-muted-foreground">
                  <span
                    className={`size-1.5 rounded-full ${
                      billing.status === 'active' ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                  {t(`account.billing.statuses.${billing.status}`)}
                </span>
              )}
            </span>
            <span className="text-xs/4 text-muted-foreground">
              {billing
                ? [
                    `${t('account.billing.labels.maxFile')} ${formatBytes(billing.limits.maxFileSize)}`,
                    `${t('account.billing.labels.vaults')} ${
                      billing.limits.maxVaults ?? t('account.billing.unlimited')
                    }`,
                    `${t('account.billing.labels.history')} ${t('account.billing.historyDays', {
                      days: billing.limits.versionHistoryDays
                    })}`
                  ].join(' · ')
                : t('account.billing.checking')}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => void handleRefreshBilling()}
              disabled={isBillingRefreshing}
              className="inline-flex items-center gap-1 text-xs/4 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw
                className={`size-3 ${isBillingRefreshing ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {t('account.billing.actions.refresh')}
            </button>
            <button
              type="button"
              onClick={() => void handleOpenBillingPortal()}
              disabled={isPortalOpening || !billing?.canManageBilling}
              className="inline-flex items-center gap-1 text-xs/4 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
            >
              <ExternalLink className="size-3" aria-hidden="true" />
              {t('account.billing.actions.manage')}
            </button>
            <Button
              variant="outline"
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
          </div>
        </div>

        {billing?.status === 'active' &&
          billing.cadence === 'monthly' &&
          (billing.plan === 'plus' || billing.plan === 'pro') && (
            <AnnualSwitchRow plan={billing.plan} onSwitched={setBilling} />
          )}

        {(activationPending || billingError) && (
          <div className="flex items-start gap-2 py-3 text-xs/4 text-muted-foreground">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
            <span>
              {billingError ?? (
                <>
                  {t('account.billing.activationPendingPrefix')}{' '}
                  <a
                    className="font-medium text-foreground underline underline-offset-2"
                    href={`mailto:${BILLING_SUPPORT_EMAIL}`}
                  >
                    {BILLING_SUPPORT_EMAIL}
                  </a>
                  .
                </>
              )}
            </span>
          </div>
        )}
      </SettingsGroup>

      <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
        <span className="text-xs/4 text-muted-foreground">
          {t('account.security.signOut.description')}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowSignOutDialog(true)}
          className="h-7 shrink-0 px-3 text-xs/4 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
        >
          {t('account.security.signOut.action')}
        </Button>
      </div>

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
