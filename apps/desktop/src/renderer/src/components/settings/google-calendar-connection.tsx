import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  calendarService,
  connectGoogleCalendarProvider,
  disconnectGoogleCalendarProvider,
  getGoogleCalendarStatus,
  refreshGoogleCalendarProvider,
  retryGoogleCalendarSourceSync,
  updateGoogleCalendarSourceSelection
} from '@/services/calendar-service'
import type { CalendarProviderStatus } from '@/services/calendar-service'
import { GoogleCalendarSourcePicker } from './google-calendar-source-picker'
import {
  CALENDAR_BORDERED_BUTTON,
  CALENDAR_DESTRUCTIVE_BUTTON,
  CALENDAR_QUIET_BUTTON,
  CalendarProviderRow,
  CalendarStatusLabel,
  CalendarSwitchRow,
  type CalendarStatusTone
} from '@/components/settings/calendar-provider-row'
import { GoogleCalendarOnboardingDialog } from '@/components/calendar/google-calendar-onboarding-dialog'
import { googleCalendarsQueryKey } from '@/hooks/use-google-calendars'
import { useT } from '@memry/i18n/renderer'

const GOOGLE_STATUS_QUERY_KEY = ['calendar', 'google', 'status'] as const
const GOOGLE_SOURCES_QUERY_KEY = ['calendar', 'google', 'sources'] as const
const GOOGLE_SETTINGS_QUERY_KEY = ['calendar', 'google', 'settings'] as const

async function invalidateGoogleCalendarQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: GOOGLE_STATUS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: GOOGLE_SOURCES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
  ])
}

type GoogleAccountStatus = NonNullable<CalendarProviderStatus['accounts']>[number]

function accountDetail(account: GoogleAccountStatus, reconnectLabel: string): string | null {
  if (account.status === 'reconnect_required') return reconnectLabel
  if (account.status === 'error') return account.lastError?.slice(0, 60) ?? null
  return null
}

function accountDotClass(status: GoogleAccountStatus['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500'
    case 'reconnect_required':
      return 'bg-amber-500'
    case 'error':
      return 'bg-destructive'
    default:
      return 'border border-muted-foreground/60'
  }
}

export function GoogleCalendarConnection(): React.JSX.Element {
  const { t } = useT('settings')
  const queryClient = useQueryClient()
  const [showOnboarding, setShowOnboarding] = useState(false)
  // Guard against reopening across renders if the user dismissed the modal
  // without committing (Codex M2 review finding 3 — without this, existing-
  // connected users would see the modal re-pop every time status refetches).
  const onboardingPromptShownRef = useRef(false)

  const { data: statusData } = useQuery({
    queryKey: GOOGLE_STATUS_QUERY_KEY,
    queryFn: () => getGoogleCalendarStatus()
  })

  const { data: sourcesData } = useQuery({
    queryKey: GOOGLE_SOURCES_QUERY_KEY,
    queryFn: () => calendarService.listSources({ provider: 'google', kind: 'calendar' })
  })

  const { data: googleSettingsData, isLoading: googleSettingsIsLoading } = useQuery({
    queryKey: GOOGLE_SETTINGS_QUERY_KEY,
    queryFn: () => window.api.settings.getCalendarGoogleSettings()
  })

  const connectMutation = useMutation({
    mutationFn: async () => {
      const result = await connectGoogleCalendarProvider()
      if (!result.success) {
        throw new Error(result.error ?? t('calendar.google.connectFailed'))
      }
      return result
    },
    onSuccess: async () => {
      await invalidateGoogleCalendarQueries(queryClient)
      // Surface onboarding the first time the user connects so they pick
      // their default target before anything lands in "memrynote" by accident.
      const settings = await window.api.settings.getCalendarGoogleSettings()
      if (!settings.onboardingCompleted) {
        setShowOnboarding(true)
      }
    }
  })

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const result = await refreshGoogleCalendarProvider()
      if (!result.success) {
        throw new Error(result.error ?? t('calendar.google.refreshFailed'))
      }
      return result
    },
    onSuccess: async () => {
      await invalidateGoogleCalendarQueries(queryClient)
    }
  })

  const disconnectMutation = useMutation({
    mutationFn: async (accountId?: string) => {
      const result = await disconnectGoogleCalendarProvider(accountId)
      if (!result.success) {
        throw new Error(result.error ?? t('calendar.google.disconnectFailed'))
      }
      return result
    },
    onSuccess: async () => {
      await invalidateGoogleCalendarQueries(queryClient)
    }
  })

  const sourceMutation = useMutation({
    mutationFn: ({ sourceId, isSelected }: { sourceId: string; isSelected: boolean }) =>
      updateGoogleCalendarSourceSelection({ id: sourceId, isSelected }),
    onSuccess: async () => {
      await invalidateGoogleCalendarQueries(queryClient)
    }
  })

  const retryMutation = useMutation({
    mutationFn: async (sourceId: string) => {
      const result = await retryGoogleCalendarSourceSync({ sourceId })
      if (!result.success) {
        throw new Error(result.error ?? t('calendar.google.retryFailed'))
      }
      return result
    },
    onSuccess: async () => {
      await invalidateGoogleCalendarQueries(queryClient)
    }
  })

  const pushSettingMutation = useMutation({
    mutationFn: async (pushEventsToGoogle: boolean) => {
      const result = await window.api.settings.setCalendarGoogleSettings({ pushEventsToGoogle })
      if (!result.success) {
        throw new Error(result.error ?? t('calendar.google.pushToGoogle.error'))
      }
      return result
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GOOGLE_SETTINGS_QUERY_KEY })
    }
  })

  const agentAccessMutation = useMutation({
    mutationFn: async (agentReadEventsConsent: boolean) => {
      const result = await window.api.settings.setCalendarGoogleSettings({
        agentReadEventsConsent
      })
      if (!result.success) {
        throw new Error(result.error ?? t('calendar.google.agentAccess.error'))
      }
      return result
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: GOOGLE_SETTINGS_QUERY_KEY })
    }
  })

  // Re-open onboarding for users who connected before M2 shipped OR who
  // closed the dialog last time without picking a default. Single auto-open
  // per mount via the ref above; settings.onboardingCompleted flips to true
  // on confirm/skip so later mounts stay quiet.
  useEffect(() => {
    if (!statusData?.connected) return
    if (onboardingPromptShownRef.current) return
    let cancelled = false
    void window.api.settings.getCalendarGoogleSettings().then((settings) => {
      if (cancelled) return
      if (!settings.onboardingCompleted) {
        onboardingPromptShownRef.current = true
        setShowOnboarding(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [statusData?.connected])

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
    const accounts = statusData?.accounts ?? []
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
  }, [statusData?.accounts, importedSources])
  const status = statusData
  const pushEventsToGoogle = googleSettingsData?.pushEventsToGoogle ?? true
  // Only an explicit grant counts. Unanswered (null) and revoked both read as off.
  const agentReadEventsConsent = googleSettingsData?.agentReadEventsConsent === true
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

  const connected = Boolean(status?.connected)
  const statusTone: CalendarStatusTone = connected
    ? reconnectRequired && !status?.hasLocalAuth
      ? 'warn'
      : 'ok'
    : 'off'
  const statusLabel = connected
    ? reconnectRequired && !status?.hasLocalAuth
      ? t('calendar.google.statuses.reconnectRequired')
      : t('calendar.google.statuses.connected')
    : t('calendar.google.statuses.notConnected')
  const accountEmails = (status?.accounts ?? []).map((account) => account.email).join(', ')
  const pickerProps = {
    isUpdating: isPending,
    onToggleSource: (sourceId: string, isSelected: boolean) =>
      sourceMutation.mutate({ sourceId, isSelected }),
    onRetrySource: (sourceId: string) => retryMutation.mutate(sourceId),
    retryingSourceId: retryMutation.isPending ? (retryMutation.variables ?? null) : null,
    defaultRemoteId: googleSettingsData?.defaultTargetCalendarId ?? null
  }

  return (
    <>
      <CalendarProviderRow
        providerId="google"
        tile="G"
        name={t('calendar.google.name')}
        data-testid="calendar-provider-row-google"
        defaultOpen={connected}
        onConnectRequest={() => {
          if (!isPending) connectMutation.mutate()
        }}
        hint={
          <>
            <CalendarStatusLabel tone={statusTone} label={statusLabel} />
            <span className="truncate">
              {'· '}
              {connected && accountEmails ? accountEmails : t('calendar.google.description')}
            </span>
          </>
        }
        meta={
          connected ? (
            <span
              data-testid="calendar-provider-count-google"
              data-selected-count={importedSelectedCount}
              data-total-count={importedSources.length}
            >
              {t('calendar.v2.calendarCount', {
                selected: importedSelectedCount,
                count: importedSources.length
              })}
            </span>
          ) : null
        }
        action={
          connected ? null : (
            <button
              type="button"
              className={CALENDAR_BORDERED_BUTTON}
              disabled={isPending}
              onClick={() => connectMutation.mutate()}
            >
              {t('calendar.google.connect')}
            </button>
          )
        }
        alert={
          mutationError ? (
            <p role="alert" className="text-xs/4 text-destructive">
              {extractErrorMessage(mutationError, t('calendar.google.syncFailed'))}
            </p>
          ) : null
        }
      >
        {connected ? (
          <>
            {accountGroups.groups.map(({ account, calendars }) => (
              <div
                key={account.accountId}
                data-testid={`calendar-account-group-${account.accountId}`}
                className="flex flex-col gap-1"
              >
                <div className="flex min-h-7 items-center justify-between gap-3">
                  <span
                    data-testid={`calendar-account-chip-${account.accountId}`}
                    data-account-status={account.status}
                    className="flex min-w-0 items-center gap-1.5 text-xs/4 text-foreground"
                    title={account.lastError ?? undefined}
                  >
                    <span
                      aria-hidden
                      className={`size-1.5 shrink-0 rounded-full ${accountDotClass(account.status)}`}
                    />
                    <span className="truncate">{account.email}</span>
                    {accountDetail(account, t('calendar.google.accountReconnect')) && (
                      <span className="max-w-[12rem] truncate text-muted-foreground">
                        · {accountDetail(account, t('calendar.google.accountReconnect'))}
                      </span>
                    )}
                  </span>

                  <button
                    type="button"
                    className={CALENDAR_DESTRUCTIVE_BUTTON}
                    data-testid={`calendar-account-disconnect-${account.accountId}`}
                    disabled={isPending}
                    onClick={() => disconnectMutation.mutate(account.accountId)}
                  >
                    {t('calendar.google.disconnect')}
                  </button>
                </div>

                <GoogleCalendarSourcePicker sources={calendars} {...pickerProps} />
              </div>
            ))}

            {accountGroups.unclaimed.length > 0 && (
              <GoogleCalendarSourcePicker sources={accountGroups.unclaimed} {...pickerProps} />
            )}

            <div className="flex flex-col gap-3">
              <CalendarSwitchRow
                label={t('calendar.google.pushToGoogle.label')}
                description={t('calendar.google.pushToGoogle.description')}
                checked={pushEventsToGoogle}
                disabled={pushSettingMutation.isPending || googleSettingsIsLoading}
                onCheckedChange={(checked) => pushSettingMutation.mutate(checked)}
              />
              <CalendarSwitchRow
                label={t('calendar.google.agentAccess.label')}
                description={t('calendar.google.agentAccess.description')}
                checked={agentReadEventsConsent}
                disabled={agentAccessMutation.isPending || googleSettingsIsLoading}
                onCheckedChange={(checked) => agentAccessMutation.mutate(checked)}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
              {reconnectRequired ? (
                <button
                  type="button"
                  className={CALENDAR_BORDERED_BUTTON}
                  disabled={isPending}
                  onClick={() => connectMutation.mutate()}
                >
                  {t('calendar.google.reconnect')}
                </button>
              ) : (
                <button
                  type="button"
                  className={CALENDAR_QUIET_BUTTON}
                  disabled={isPending}
                  onClick={() => refreshMutation.mutate()}
                >
                  {t('calendar.google.syncNow')}
                </button>
              )}
              <button
                type="button"
                className={CALENDAR_QUIET_BUTTON}
                data-testid="calendar-add-account"
                disabled={isPending}
                onClick={() => connectMutation.mutate()}
              >
                {t('calendar.google.addAccount')}
              </button>
              {/* Per-account disconnect lives in each account above. This is the
                  way out for an install that reports no account rows at all —
                  without it such a user would be connected with no way to undo it. */}
              {accountGroups.groups.length === 0 && (
                <button
                  type="button"
                  className={CALENDAR_DESTRUCTIVE_BUTTON}
                  data-testid="calendar-disconnect-all"
                  disabled={isPending}
                  onClick={() => disconnectMutation.mutate(undefined)}
                >
                  {t('calendar.google.disconnect')}
                </button>
              )}
            </div>
          </>
        ) : null}
      </CalendarProviderRow>

      <GoogleCalendarOnboardingDialog
        open={showOnboarding}
        onOpenChange={setShowOnboarding}
        onCompleted={async () => {
          await queryClient.invalidateQueries({ queryKey: googleCalendarsQueryKey })
        }}
      />
    </>
  )
}

export default GoogleCalendarConnection
