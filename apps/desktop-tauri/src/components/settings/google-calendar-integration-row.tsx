import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { invoke } from '@/lib/ipc/invoke'

const GOOGLE_STATUS_QUERY_KEY = ['calendar', 'google', 'status'] as const
const GOOGLE_SOURCES_QUERY_KEY = ['calendar', 'google', 'sources'] as const

async function invalidateGoogleCalendarQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: GOOGLE_STATUS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: GOOGLE_SOURCES_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] })
  ])
}

export function GoogleCalendarIntegrationRow(): React.JSX.Element {
  const queryClient = useQueryClient()
  const [showOnboarding, setShowOnboarding] = useState(false)
  // Guard against reopening across renders if the user dismissed the modal
  // without committing (Codex M2 review finding 3 — without this, existing-
  // connected users would see the modal re-pop every time status refetches).
  const onboardingPromptShownRef = useRef(false)

  const statusQuery = useQuery({
    queryKey: GOOGLE_STATUS_QUERY_KEY,
    queryFn: () => getGoogleCalendarStatus()
  })

  const sourcesQuery = useQuery({
    queryKey: GOOGLE_SOURCES_QUERY_KEY,
    queryFn: () => calendarService.listSources({ provider: 'google', kind: 'calendar' })
  })

  const connectMutation = useMutation({
    mutationFn: async () => {
      const result = await connectGoogleCalendarProvider()
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to connect Google Calendar')
      }
      return result
    },
    onSuccess: async () => {
      await invalidateGoogleCalendarQueries(queryClient)
      // Surface onboarding the first time the user connects so they pick
      // their default target before anything lands in "Memry" by accident.
      const settings = await invoke<{ onboardingCompleted?: boolean }>(
        'settings_get_calendar_google_settings'
      )
      if (!settings.onboardingCompleted) {
        setShowOnboarding(true)
      }
    }
  })

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const result = await refreshGoogleCalendarProvider()
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to refresh Google Calendar')
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
        throw new Error(result.error ?? 'Failed to disconnect Google Calendar')
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
        throw new Error(result.error ?? 'Retry failed')
      }
      return result
    },
    onSuccess: async () => {
      await invalidateGoogleCalendarQueries(queryClient)
    }
  })

  // Re-open onboarding for users who connected before M2 shipped OR who
  // closed the dialog last time without picking a default. Single auto-open
  // per mount via the ref above; settings.onboardingCompleted flips to true
  // on confirm/skip so later mounts stay quiet.
  useEffect(() => {
    if (!statusQuery.data?.connected) return
    if (onboardingPromptShownRef.current) return
    let cancelled = false
    void invoke<{ onboardingCompleted?: boolean }>('settings_get_calendar_google_settings').then(
      (settings) => {
        if (cancelled) return
        if (!settings.onboardingCompleted) {
          onboardingPromptShownRef.current = true
          setShowOnboarding(true)
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [statusQuery.data?.connected])

  const sources = sourcesQuery.data?.sources ?? []
  const importedSources = useMemo(
    () => sources.filter((source) => !source.isMemryManaged),
    [sources]
  )
  const status = statusQuery.data
  const reconnectRequired = Boolean(
    status?.accounts?.some((account) => account.status === 'reconnect_required')
  )
  const isPending =
    connectMutation.isPending ||
    refreshMutation.isPending ||
    disconnectMutation.isPending ||
    sourceMutation.isPending

  const mutationError =
    connectMutation.error ?? refreshMutation.error ?? disconnectMutation.error ?? null

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Calendar className="size-4 text-muted-foreground" />
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px]/4 font-medium text-foreground">Google Calendar</span>
              <Badge variant="secondary" className="h-4 border-0 px-1.5 py-0 text-[10px]/3">
                OAuth 2.0
              </Badge>
              <Badge
                variant="secondary"
                className="h-4 border-0 px-1.5 py-0 text-[10px]/3 text-foreground"
              >
                {status?.connected
                  ? reconnectRequired && !status.hasLocalAuth
                    ? 'Reconnect Required'
                    : 'Connected'
                  : 'Not Connected'}
              </Badge>
            </div>

            <p className="text-xs/4 text-muted-foreground">
              Two-way sync for Memry events and imported Google calendars.
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
                      ? 'Reconnect Google'
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
                {extractErrorMessage(mutationError, 'Something went wrong')}
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
                  Reconnect Google
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-3 text-xs/4"
                  disabled={isPending}
                  onClick={() => refreshMutation.mutate()}
                >
                  Sync Now
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 text-xs/4"
                disabled={isPending}
                onClick={() => disconnectMutation.mutate()}
              >
                Disconnect
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
              Connect
            </Button>
          )}
        </div>
      </div>

      {status?.connected && (
        <div className="mt-3 grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px]/3.5 font-medium uppercase tracking-[0.05em] text-muted-foreground">
              Imported Calendars
            </span>
            <span className="text-xs text-muted-foreground">
              {status.calendars.selected} selected
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
