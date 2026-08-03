import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Calendar } from '@/lib/icons'
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
import { GoogleCalendarSourcePicker } from './google-calendar-source-picker'
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

export function GoogleCalendarIntegrationRow(): React.JSX.Element {
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
        throw new Error(result.error ?? t('integrations.googleCalendar.connectFailed'))
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
        throw new Error(result.error ?? t('integrations.googleCalendar.refreshFailed'))
      }
      return result
    },
    onSuccess: async () => {
      await invalidateGoogleCalendarQueries(queryClient)
    }
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const result = await disconnectGoogleCalendarProvider()
      if (!result.success) {
        throw new Error(result.error ?? t('integrations.googleCalendar.disconnectFailed'))
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
        throw new Error(result.error ?? t('integrations.googleCalendar.retryFailed'))
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
        throw new Error(result.error ?? t('integrations.googleCalendar.pushToGoogle.error'))
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
        throw new Error(result.error ?? t('integrations.googleCalendar.agentAccess.error'))
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

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Calendar className="size-4 text-muted-foreground" />
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px]/4 font-medium text-foreground">
                {t('integrations.googleCalendar.name')}
              </span>
              <Badge variant="secondary" className="h-4 border-0 px-1.5 py-0 text-[10px]/3">
                {t('integrations.auth.oauth2')}
              </Badge>
              <Badge
                variant="secondary"
                className="h-4 border-0 px-1.5 py-0 text-[10px]/3 text-foreground"
              >
                {status?.connected
                  ? reconnectRequired && !status.hasLocalAuth
                    ? t('integrations.googleCalendar.statuses.reconnectRequired')
                    : t('integrations.googleCalendar.statuses.connected')
                  : t('integrations.googleCalendar.statuses.notConnected')}
              </Badge>
            </div>

            <p className="text-xs/4 text-muted-foreground">
              {t('integrations.googleCalendar.description')}
            </p>

            {status?.accounts && status.accounts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {status.accounts.map((account) => {
                  const tone =
                    account.status === 'connected'
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : account.status === 'reconnect_required'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                        : account.status === 'error'
                          ? 'border-destructive/50 bg-destructive/10 text-destructive'
                          : 'border-muted-foreground/30 bg-muted text-muted-foreground'
                  const detail =
                    account.status === 'reconnect_required'
                      ? t('integrations.googleCalendar.accountReconnect')
                      : account.status === 'error'
                        ? account.lastError?.slice(0, 60)
                        : null
                  return (
                    <span
                      key={account.accountId}
                      data-testid={`calendar-account-chip-${account.accountId}`}
                      data-account-status={account.status}
                      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]/4 ${tone}`}
                      title={account.lastError ?? undefined}
                    >
                      <span className="truncate">{account.email}</span>
                      {detail && (
                        <span className="max-w-[12rem] truncate text-[10px]/3 opacity-75">
                          · {detail}
                        </span>
                      )}
                    </span>
                  )
                })}
              </div>
            )}

            {mutationError && (
              <p className="text-xs text-destructive">
                {extractErrorMessage(mutationError, t('integrations.googleCalendar.syncFailed'))}
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
                  {t('integrations.googleCalendar.reconnect')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs/4"
                  disabled={isPending}
                  onClick={() => refreshMutation.mutate()}
                >
                  {t('integrations.googleCalendar.syncNow')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 text-xs/4"
                disabled={isPending}
                onClick={() => disconnectMutation.mutate()}
              >
                {t('integrations.googleCalendar.disconnect')}
              </Button>
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
              {t('integrations.googleCalendar.importedCalendars')}
            </span>
            <span className="text-xs text-muted-foreground">
              {t('integrations.googleCalendar.selected', { count: status.calendars.selected })}
            </span>
          </div>

          <GoogleCalendarSourcePicker
            sources={importedSources}
            isUpdating={isPending}
            onToggleSource={(sourceId, isSelected) =>
              sourceMutation.mutate({ sourceId, isSelected })
            }
            onRetrySource={(sourceId) => retryMutation.mutate(sourceId)}
            retryingSourceId={retryMutation.isPending ? (retryMutation.variables ?? null) : null}
          />

          <div className="mt-1 flex items-start justify-between gap-3 border-t border-border/60 pt-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px]/4 font-medium text-foreground">
                {t('integrations.googleCalendar.pushToGoogle.label')}
              </span>
              <p className="text-xs/4 text-muted-foreground">
                {t('integrations.googleCalendar.pushToGoogle.description')}
              </p>
            </div>
            <Switch
              checked={pushEventsToGoogle}
              disabled={pushSettingMutation.isPending || googleSettingsIsLoading}
              onCheckedChange={(checked) => pushSettingMutation.mutate(checked)}
              aria-label={t('integrations.googleCalendar.pushToGoogle.label')}
            />
          </div>

          <div className="mt-1 flex items-start justify-between gap-3 border-t border-border/60 pt-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px]/4 font-medium text-foreground">
                {t('integrations.googleCalendar.agentAccess.label')}
              </span>
              <p className="text-xs/4 text-muted-foreground">
                {t('integrations.googleCalendar.agentAccess.description')}
              </p>
            </div>
            <Switch
              checked={agentReadEventsConsent}
              disabled={agentAccessMutation.isPending || googleSettingsIsLoading}
              onCheckedChange={(checked) => agentAccessMutation.mutate(checked)}
              aria-label={t('integrations.googleCalendar.agentAccess.label')}
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

export default GoogleCalendarIntegrationRow
