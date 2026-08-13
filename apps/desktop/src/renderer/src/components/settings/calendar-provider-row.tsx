import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { extractErrorMessage } from '@/lib/ipc-error'
import { calendarProviderPresentation } from '@/lib/calendar-provider-presentation'
import {
  calendarService,
  connectCalendarProvider,
  disconnectCalendarProvider,
  getCalendarProviderStatus,
  refreshCalendarProvider,
  retryCalendarSourceSync,
  updateGoogleCalendarSourceSelection
} from '@/services/calendar-service'
import type {
  CalendarProviderDescriptor,
  CalendarProviderStatus
} from '@memry/contracts/calendar-api'
import { GoogleCalendarSourcePicker } from './google-calendar-source-picker'
import { GoogleCalendarOnboardingDialog } from '@/components/calendar/google-calendar-onboarding-dialog'
import { googleCalendarsQueryKey } from '@/hooks/use-google-calendars'
import { useT } from '@memry/i18n/renderer'

/** Every calendar query is namespaced by provider, so two providers never share a cache slot. */
export const calendarProviderStatusQueryKey = (providerId: string) =>
  ['calendar', providerId, 'status'] as const
export const calendarProviderSourcesQueryKey = (providerId: string) =>
  ['calendar', providerId, 'sources'] as const
export const calendarProviderSettingsQueryKey = (providerId: string) =>
  ['calendar', providerId, 'settings'] as const

/** The polling cadence the runner uses for a provider with no push channels. */
const POLL_INTERVAL_MINUTES = 5

type AccountStatus = NonNullable<CalendarProviderStatus['accounts']>[number]

function accountDetail(account: AccountStatus, reconnectLabel: string): string | null {
  if (account.status === 'reconnect_required') return reconnectLabel
  if (account.status === 'error') return account.lastError?.slice(0, 60) ?? null
  return null
}

function accountToneClass(status: AccountStatus['status']): string {
  switch (status) {
    case 'connected':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    case 'reconnect_required':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
    case 'error':
      return 'border-destructive/50 bg-destructive/10 text-destructive'
    default:
      return 'border-muted-foreground/30 bg-muted text-muted-foreground'
  }
}

/**
 * One connected calendar provider in Settings → Integrations.
 *
 * Every affordance is driven by `provider.capabilities`, which main reports:
 * a read-only provider is never offered a "push events" toggle, a
 * single-connection provider never shows an account list or an "Add account"
 * button, and a provider with no push channels advertises its poll interval
 * instead of claiming real-time sync.
 */
export function CalendarProviderRow({
  provider
}: {
  provider: CalendarProviderDescriptor
}): React.JSX.Element {
  const { t } = useT('settings')
  const queryClient = useQueryClient()
  const providerId = provider.id
  const { icon: Icon, i18nKey } = calendarProviderPresentation(providerId)
  const providerName = t(`integrations.registry.${i18nKey}.name`)
  const { supportsWrite, supportsMultiAccount, supportsPush, authFlow } = provider.capabilities

  const [showOnboarding, setShowOnboarding] = useState(false)
  // Guard against reopening across renders if the user dismissed the modal
  // without committing (Codex M2 review finding 3 — without this, existing-
  // connected users would see the modal re-pop every time status refetches).
  const onboardingPromptShownRef = useRef(false)

  const invalidateProviderQueries = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: calendarProviderStatusQueryKey(providerId) }),
      queryClient.invalidateQueries({ queryKey: calendarProviderSourcesQueryKey(providerId) }),
      queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
    ])
  }

  const { data: statusData } = useQuery({
    queryKey: calendarProviderStatusQueryKey(providerId),
    queryFn: () => getCalendarProviderStatus(providerId)
  })

  const { data: sourcesData } = useQuery({
    queryKey: calendarProviderSourcesQueryKey(providerId),
    queryFn: () => calendarService.listSources({ provider: providerId, kind: 'calendar' })
  })

  const { data: providerSettings, isLoading: providerSettingsIsLoading } = useQuery({
    queryKey: calendarProviderSettingsQueryKey(providerId),
    queryFn: () => window.api.settings.getCalendarProviderSettings(providerId)
  })

  const connectMutation = useMutation({
    mutationFn: async () => {
      const result = await connectCalendarProvider(providerId)
      if (!result.success) {
        throw new Error(
          result.error ??
            t('integrations.calendarProvider.connectFailed', { provider: providerName })
        )
      }
      return result
    },
    onSuccess: async () => {
      await invalidateProviderQueries()
      // Surface onboarding the first time the user connects so they pick
      // their default target before anything lands in "memrynote" by accident.
      // Only a provider we can write to has a target to pick.
      if (!supportsWrite) return
      const settings = await window.api.settings.getCalendarProviderSettings(providerId)
      if (!settings.onboardingCompleted) {
        setShowOnboarding(true)
      }
    }
  })

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const result = await refreshCalendarProvider(providerId)
      if (!result.success) {
        throw new Error(
          result.error ??
            t('integrations.calendarProvider.refreshFailed', { provider: providerName })
        )
      }
      return result
    },
    onSuccess: invalidateProviderQueries
  })

  const disconnectMutation = useMutation({
    mutationFn: async (accountId?: string) => {
      const result = await disconnectCalendarProvider(providerId, accountId)
      if (!result.success) {
        throw new Error(
          result.error ??
            t('integrations.calendarProvider.disconnectFailed', { provider: providerName })
        )
      }
      return result
    },
    onSuccess: invalidateProviderQueries
  })

  const sourceMutation = useMutation({
    mutationFn: ({ sourceId, isSelected }: { sourceId: string; isSelected: boolean }) =>
      updateGoogleCalendarSourceSelection({ id: sourceId, isSelected }),
    onSuccess: invalidateProviderQueries
  })

  const retryMutation = useMutation({
    mutationFn: async (sourceId: string) => {
      const result = await retryCalendarSourceSync({ sourceId })
      if (!result.success) {
        throw new Error(result.error ?? t('integrations.calendarProvider.retryFailed'))
      }
      return result
    },
    onSuccess: invalidateProviderQueries
  })

  const pushSettingMutation = useMutation({
    mutationFn: async (pushEventsToProvider: boolean) => {
      const result = await window.api.settings.setCalendarProviderSettings(providerId, {
        pushEventsToProvider
      })
      if (!result.success) {
        throw new Error(result.error ?? t('integrations.calendarProvider.pushEvents.error'))
      }
      return result
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: calendarProviderSettingsQueryKey(providerId)
      })
    }
  })

  const agentAccessMutation = useMutation({
    mutationFn: async (agentReadEventsConsent: boolean) => {
      const result = await window.api.settings.setCalendarProviderSettings(providerId, {
        agentReadEventsConsent
      })
      if (!result.success) {
        throw new Error(result.error ?? t('integrations.calendarProvider.agentAccess.error'))
      }
      return result
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: calendarProviderSettingsQueryKey(providerId)
      })
    }
  })

  // Re-open onboarding for users who connected before M2 shipped OR who
  // closed the dialog last time without picking a default. Single auto-open
  // per mount via the ref above; settings.onboardingCompleted flips to true
  // on confirm/skip so later mounts stay quiet.
  useEffect(() => {
    if (!statusData?.connected) return
    if (!supportsWrite) return
    if (onboardingPromptShownRef.current) return
    let cancelled = false
    void window.api.settings.getCalendarProviderSettings(providerId).then((settings) => {
      if (cancelled) return
      if (!settings.onboardingCompleted) {
        onboardingPromptShownRef.current = true
        setShowOnboarding(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [statusData?.connected, providerId, supportsWrite])

  const importedSources = useMemo(
    () => (sourcesData?.sources ?? []).filter((source) => !source.isMemryManaged),
    [sourcesData?.sources]
  )

  // Count what this section actually renders. `status.calendars.selected` counts
  // every selected calendar row including the memrynote-managed one, which the
  // list above deliberately hides — so a single connected account read as
  // "2 selected" next to one visible calendar (#1205).
  const importedSelectedCount = useMemo(
    () => importedSources.filter((source) => source.isSelected).length,
    [importedSources]
  )

  // One group per connected account, plus a trailing group for calendars whose
  // accountId matches no account we know about. Those exist on installs that
  // connected before sources carried an account id — dropping them here would
  // make a working calendar silently disappear from Settings.
  const accountGroups = useMemo(() => {
    const accounts = supportsMultiAccount ? (statusData?.accounts ?? []) : []
    const claimed = new Set<string>()
    const groups = accounts.map((account) => {
      const calendars = importedSources.filter((source) => {
        if (source.accountId !== account.accountId) return false
        claimed.add(source.id)
        return true
      })
      return { account, calendars }
    })
    const unclaimed = importedSources.filter((source) => !claimed.has(source.id))
    return { groups, unclaimed }
  }, [statusData?.accounts, importedSources, supportsMultiAccount])

  const status = statusData
  const pushEventsToProvider = providerSettings?.pushEventsToProvider ?? true
  // Only an explicit grant counts. Unanswered (null) and revoked both read as off.
  const agentReadEventsConsent = providerSettings?.agentReadEventsConsent === true
  const reconnectRequired = Boolean(
    status?.accounts?.some((account) => account.status === 'reconnect_required')
  )
  const isPending =
    connectMutation.isPending ||
    refreshMutation.isPending ||
    disconnectMutation.isPending ||
    sourceMutation.isPending

  const mutationError =
    connectMutation.error ??
    refreshMutation.error ??
    disconnectMutation.error ??
    pushSettingMutation.error ??
    null

  const sourcePicker = (sources: typeof importedSources): React.JSX.Element => (
    <GoogleCalendarSourcePicker
      sources={sources}
      isUpdating={isPending}
      onToggleSource={(sourceId, isSelected) => sourceMutation.mutate({ sourceId, isSelected })}
      onRetrySource={(sourceId) => retryMutation.mutate(sourceId)}
      retryingSourceId={retryMutation.isPending ? (retryMutation.variables ?? null) : null}
    />
  )

  return (
    <div className="px-4 py-3" data-testid={`calendar-provider-row-${providerId}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="size-4 text-muted-foreground" />
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px]/4 font-medium text-foreground">{providerName}</span>
              <Badge variant="secondary" className="h-4 border-0 px-1.5 py-0 text-[10px]/3">
                {t(`integrations.auth.${authFlow === 'oauth2' ? 'oauth2' : authFlow}`)}
              </Badge>
              <Badge
                variant="secondary"
                className="h-4 border-0 px-1.5 py-0 text-[10px]/3 text-foreground"
              >
                {status?.connected
                  ? reconnectRequired && !status.hasLocalAuth
                    ? t('integrations.calendarProvider.statuses.reconnectRequired')
                    : t('integrations.calendarProvider.statuses.connected')
                  : t('integrations.calendarProvider.statuses.notConnected')}
              </Badge>
            </div>

            <p className="text-xs/4 text-muted-foreground">
              {t(`integrations.registry.${i18nKey}.description`)}
            </p>

            {/* Say what the provider can actually do, rather than letting the
                user assume Google's behavior for all of them. */}
            <p
              className="text-[11px]/4 text-muted-foreground"
              data-testid="calendar-provider-cadence"
            >
              {supportsPush
                ? t('integrations.calendarProvider.realtime')
                : t('integrations.calendarProvider.pollInterval', {
                    minutes: POLL_INTERVAL_MINUTES
                  })}
              {!supportsWrite && ` ${t('integrations.calendarProvider.readOnlyNotice')}`}
            </p>

            {mutationError && (
              <p className="text-xs text-destructive">
                {extractErrorMessage(mutationError, t('integrations.calendarProvider.syncFailed'))}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {status?.connected ? (
            <>
              {reconnectRequired ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs/4"
                  disabled={isPending}
                  onClick={() => connectMutation.mutate()}
                >
                  {t('integrations.calendarProvider.reconnect')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs/4"
                  disabled={isPending}
                  onClick={() => refreshMutation.mutate()}
                >
                  {t('integrations.calendarProvider.syncNow')}
                </Button>
              )}
              {supportsMultiAccount && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs/4"
                  data-testid="calendar-add-account"
                  disabled={isPending}
                  onClick={() => connectMutation.mutate()}
                >
                  {t('integrations.calendarProvider.addAccount')}
                </Button>
              )}
              {/* Per-account disconnect lives in each group below. This is the
                  way out for a single-connection provider, and for an install
                  that reports no account rows at all — without it such a user
                  would be connected with no way to undo it. */}
              {accountGroups.groups.length === 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs/4"
                  data-testid="calendar-disconnect-all"
                  disabled={isPending}
                  onClick={() => disconnectMutation.mutate(undefined)}
                >
                  {t('integrations.calendarProvider.disconnect')}
                </Button>
              )}
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs/4"
              disabled={isPending}
              onClick={() => connectMutation.mutate()}
            >
              {t('integrations.connect')}
            </Button>
          )}
        </div>
      </div>

      {status?.connected && (
        <div className="mt-3 grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px]/3.5 font-medium uppercase tracking-[0.05em] text-muted-foreground">
              {t('integrations.calendarProvider.importedCalendars')}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('integrations.calendarProvider.selected', { count: importedSelectedCount })}
            </span>
          </div>

          {accountGroups.groups.map(({ account, calendars }) => (
            <div
              key={account.accountId}
              data-testid={`calendar-account-group-${account.accountId}`}
              className="grid gap-2 rounded-md border border-border/70 px-3 py-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  data-testid={`calendar-account-chip-${account.accountId}`}
                  data-account-status={account.status}
                  className={`inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]/4 ${accountToneClass(account.status)}`}
                  title={account.lastError ?? undefined}
                >
                  <span className="truncate">{account.email}</span>
                  {accountDetail(
                    account,
                    t('integrations.calendarProvider.accountReconnect', { provider: providerName })
                  ) && (
                    <span className="max-w-[12rem] truncate text-[10px]/3 opacity-75">
                      ·{' '}
                      {accountDetail(
                        account,
                        t('integrations.calendarProvider.accountReconnect', {
                          provider: providerName
                        })
                      )}
                    </span>
                  )}
                </span>

                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 shrink-0 px-2 text-[11px]/4"
                  data-testid={`calendar-account-disconnect-${account.accountId}`}
                  disabled={isPending}
                  onClick={() => disconnectMutation.mutate(account.accountId)}
                >
                  {t('integrations.calendarProvider.disconnect')}
                </Button>
              </div>

              {sourcePicker(calendars)}
            </div>
          ))}

          {accountGroups.unclaimed.length > 0 && sourcePicker(accountGroups.unclaimed)}

          {/* A read-only provider has no outbound path at all — the engine
              refuses the write, so offering the toggle would be a lie. */}
          {supportsWrite && (
            <div className="mt-1 flex items-start justify-between gap-3 border-t border-border/60 pt-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px]/4 font-medium text-foreground">
                  {t('integrations.calendarProvider.pushEvents.label', { provider: providerName })}
                </span>
                <p className="text-xs/4 text-muted-foreground">
                  {t('integrations.calendarProvider.pushEvents.description')}
                </p>
              </div>
              <Switch
                checked={pushEventsToProvider}
                disabled={pushSettingMutation.isPending || providerSettingsIsLoading}
                onCheckedChange={(checked) => pushSettingMutation.mutate(checked)}
                aria-label={t('integrations.calendarProvider.pushEvents.label', {
                  provider: providerName
                })}
              />
            </div>
          )}

          <div className="mt-1 flex items-start justify-between gap-3 border-t border-border/60 pt-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px]/4 font-medium text-foreground">
                {t('integrations.calendarProvider.agentAccess.label', { provider: providerName })}
              </span>
              <p className="text-xs/4 text-muted-foreground">
                {t('integrations.calendarProvider.agentAccess.description')}
              </p>
            </div>
            <Switch
              checked={agentReadEventsConsent}
              disabled={agentAccessMutation.isPending || providerSettingsIsLoading}
              onCheckedChange={(checked) => agentAccessMutation.mutate(checked)}
              aria-label={t('integrations.calendarProvider.agentAccess.label', {
                provider: providerName
              })}
            />
          </div>
        </div>
      )}

      <GoogleCalendarOnboardingDialog
        open={showOnboarding}
        onOpenChange={setShowOnboarding}
        onCompleted={async () => {
          await queryClient.invalidateQueries({ queryKey: googleCalendarsQueryKey })
        }}
      />
    </div>
  )
}

export default CalendarProviderRow
