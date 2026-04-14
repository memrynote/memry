import { useMemo } from 'react'
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
  updateGoogleCalendarSourceSelection
} from '@/services/calendar-service'
import { GoogleCalendarSourcePicker } from './google-calendar-source-picker'

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

  const sources = sourcesQuery.data?.sources ?? []
  const importedSources = useMemo(
    () => sources.filter((source) => !source.isMemryManaged),
    [sources]
  )
  const memrySource = sources.find((source) => source.isMemryManaged) ?? null
  const status = statusQuery.data
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
                {status?.connected ? 'Connected' : 'Not Connected'}
              </Badge>
            </div>

            <p className="text-xs/4 text-muted-foreground">
              Two-way sync for Memry events and imported Google calendars.
            </p>

            {status?.account && (
              <p className="text-xs text-muted-foreground">Connected as {status.account.title}</p>
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
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 text-xs/4"
                disabled={isPending}
                onClick={() => refreshMutation.mutate()}
              >
                Sync Now
              </Button>
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
        <div className="mt-3 grid gap-3 rounded-md border border-border/70 bg-card/40 p-3">
          <div className="grid gap-1">
            <span className="text-[11px]/3.5 font-medium uppercase tracking-[0.05em] text-muted-foreground">
              Memry Calendar
            </span>
            <span className="text-xs text-foreground">{memrySource?.title ?? 'Memry'}</span>
          </div>

          <div className="grid gap-2">
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
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default GoogleCalendarIntegrationRow
