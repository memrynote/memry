import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'
import { cn } from '@/lib/utils'

export interface CalendarEventMetadataProps {
  attendees: CalendarAttendee[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  conferenceData: CalendarConferenceData | null
  className?: string
}

const RESPONSE_LABELS: Record<string, string> = {
  accepted: 'Accepted',
  declined: 'Declined',
  tentative: 'Tentative',
  needsAction: 'Pending'
}

const RESPONSE_STYLES: Record<string, string> = {
  accepted: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  declined: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
  tentative: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  needsAction: 'bg-muted text-muted-foreground'
}

function findMeetLink(conf: CalendarConferenceData | null): string | null {
  if (!conf?.entryPoints) return null
  const video = conf.entryPoints.find((ep) => ep.entryPointType === 'video' && ep.uri)
  return video?.uri ?? null
}

function hasAnyMetadata(props: CalendarEventMetadataProps): boolean {
  const meetLink = findMeetLink(props.conferenceData)
  const hasAttendees = !!props.attendees && props.attendees.length > 0
  const hasReminders = !!props.reminders
  const hasVisibility = props.visibility !== null && props.visibility !== 'default'
  return hasAttendees || hasReminders || hasVisibility || meetLink !== null
}

export function CalendarEventMetadata(props: CalendarEventMetadataProps): React.JSX.Element | null {
  if (!hasAnyMetadata(props)) return null
  const { attendees, reminders, visibility, conferenceData, className } = props
  const meetLink = findMeetLink(conferenceData)

  return (
    <div className={cn('space-y-3 text-sm', className)}>
      {meetLink && (
        <a
          href={meetLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Join meeting
        </a>
      )}

      {attendees && attendees.length > 0 && (
        <section aria-label="Attendees" className="space-y-1">
          <h3 className="text-xs font-semibold text-muted-foreground">
            Attendees ({attendees.length})
          </h3>
          <ul className="space-y-1">
            {attendees.map((attendee) => {
              const label = RESPONSE_LABELS[attendee.responseStatus ?? 'needsAction'] ?? 'Pending'
              const badgeStyle =
                RESPONSE_STYLES[attendee.responseStatus ?? 'needsAction'] ??
                RESPONSE_STYLES.needsAction
              return (
                <li key={attendee.email} className="flex items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    {attendee.displayName && (
                      <span className="truncate font-medium">{attendee.displayName}</span>
                    )}
                    <span
                      className={cn(
                        'truncate',
                        attendee.displayName ? 'text-xs text-muted-foreground' : 'text-foreground'
                      )}
                    >
                      {attendee.email}
                    </span>
                  </div>
                  {attendee.optional && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      Optional
                    </span>
                  )}
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium',
                      badgeStyle
                    )}
                  >
                    {label}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {reminders && (
        <section aria-label="Reminders" className="space-y-1">
          <h3 className="text-xs font-semibold text-muted-foreground">Reminders</h3>
          {reminders.useDefault && reminders.overrides.length === 0 ? (
            <p className="text-xs text-muted-foreground">Default reminders</p>
          ) : (
            <ul className="flex flex-wrap gap-1">
              {reminders.overrides.map((o, idx) => (
                <li
                  key={`${o.method}-${o.minutes}-${idx}`}
                  className="rounded-md bg-muted px-2 py-0.5 text-xs"
                >
                  {o.minutes} min · {o.method}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {visibility && visibility !== 'default' && (
        <section aria-label="Visibility">
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
            <span className="text-muted-foreground">Visibility:</span>
            <span className="font-medium capitalize">{visibility}</span>
          </span>
        </section>
      )}
    </div>
  )
}

export default CalendarEventMetadata
