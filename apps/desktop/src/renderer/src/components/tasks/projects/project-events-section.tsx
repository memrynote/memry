import { useCallback, useEffect, useMemo, useState } from 'react'
import { Calendar, Loader2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { tasksService } from '@/services/tasks-service'
import { calendarService } from '@/services/calendar-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('ProjectEvents')

interface LinkedEvent {
  itemId: string
  title: string
  startAt: string
  isAllDay: boolean
}

interface ProjectEventsSectionProps {
  projectId: string
  onEventClick?: (eventId: string) => void
  className?: string
}

/**
 * Project Home "Events" section — lists the calendar events linked to a
 * project (via `project_links`) and lets the user unlink one.
 */
export const ProjectEventsSection = ({
  projectId,
  onEventClick,
  className
}: ProjectEventsSectionProps): React.JSX.Element | null => {
  const { t, i18n } = useT('tasks')
  const [events, setEvents] = useState<LinkedEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', year: 'numeric' }),
    [i18n.language]
  )
  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }),
    [i18n.language]
  )

  const formatWhen = useCallback(
    (event: LinkedEvent): string => {
      const start = new Date(event.startAt)
      if (event.isAllDay) return dateFormatter.format(start)
      return `${dateFormatter.format(start)} · ${timeFormatter.format(start)}`
    },
    [dateFormatter, timeFormatter]
  )

  const loadEvents = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const links = await tasksService.listProjectLinks(projectId)
      const eventLinks = links.filter((link) => link.itemType === 'calendar_event')
      const resolved = await Promise.all(
        eventLinks.map(async (link) => {
          // Defensive: tolerate links whose event was deleted elsewhere —
          // cleanup of orphaned links is owned by a concurrent effort.
          const event = await calendarService.getEvent(link.itemId)
          if (!event) return null
          return {
            itemId: link.itemId,
            title: event.title,
            startAt: event.startAt,
            isAllDay: event.isAllDay
          }
        })
      )
      setEvents(resolved.filter((event): event is LinkedEvent => event !== null))
    } catch (error) {
      log.error(
        'Failed to load project events',
        extractErrorMessage(error, t('projectEvents.loadError'))
      )
    } finally {
      setIsLoading(false)
    }
  }, [projectId, t])

  useEffect(() => {
    void loadEvents()
  }, [loadEvents])

  const handleRemove = useCallback(
    async (itemId: string): Promise<void> => {
      try {
        await tasksService.unlinkProjectItem({ projectId, itemType: 'calendar_event', itemId })
        setEvents((prev) => prev.filter((event) => event.itemId !== itemId))
      } catch (error) {
        log.error(
          'Failed to remove event from project',
          extractErrorMessage(error, t('projectEvents.removeError'))
        )
      }
    },
    [projectId, t]
  )

  if (!isLoading && events.length === 0) return null

  return (
    <section className={cn('px-4 py-3 border-t border-border', className)}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('projectEvents.title')}
      </h3>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {t('projectEvents.loading')}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {events.map((event) => (
            <div
              key={event.itemId}
              className="group relative flex items-center gap-2 rounded-md border border-border p-2 hover:bg-surface-hover"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-start"
                onClick={() => onEventClick?.(event.itemId)}
              >
                <Calendar className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{event.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatWhen(event)}
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={t('projectEvents.removeFromProject')}
                onClick={() => void handleRemove(event.itemId)}
                className="shrink-0 rounded-sm p-1 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export default ProjectEventsSection
