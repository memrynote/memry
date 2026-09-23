import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'
import type { ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Bell, Lock, Users, Video } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { CalendarCardSection } from './calendar-card'

export interface CalendarEventMetadataProps {
  attendees: CalendarAttendee[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  conferenceData: CalendarConferenceData | null
  className?: string
}

const RESPONSE_LABEL_KEYS: Record<string, string> = {
  accepted: 'metadata.response.accepted',
  declined: 'metadata.response.declined',
  tentative: 'metadata.response.tentative',
  needsAction: 'metadata.response.needs-action'
}

const VISIBILITY_LABEL_KEYS: Record<Exclude<CalendarVisibility, 'default'>, string> = {
  public: 'metadata.visibility-value.public',
  private: 'metadata.visibility-value.private',
  confidential: 'metadata.visibility-value.confidential'
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

/** Same lane as the form's detail rows: a fixed 16px icon, then the content. */
function MetadataRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-start gap-2.5 px-2 py-1.5">
      <span
        aria-hidden
        className="flex w-4 shrink-0 justify-center pt-0.5 text-muted-foreground [&_svg]:size-4"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function CalendarEventMetadata(props: CalendarEventMetadataProps): React.JSX.Element | null {
  const { t: tPhaseF } = useT('calendar')
  const { t } = useT('calendar')
  if (!hasAnyMetadata(props)) return null
  const { attendees, reminders, visibility, conferenceData, className } = props
  const meetLink = findMeetLink(conferenceData)

  return (
    <CalendarCardSection className={cn('flex flex-col px-1.5 py-1.5 text-[13px]', className)}>
      {meetLink && (
        <div className="flex min-h-8 items-center gap-2.5 px-2">
          <span
            aria-hidden
            className="flex w-4 shrink-0 justify-center text-muted-foreground [&_svg]:size-4"
          >
            <Video />
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">
            {t('metadata.video-call')}
          </span>
          <a
            href={meetLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-6 shrink-0 items-center rounded-md bg-(--cal-indigo-solid) px-2.5 text-xs font-semibold text-(--cal-indigo-solid-ink) outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--tint-ring)"
          >
            {t('metadata.join-meeting')}
          </a>
        </div>
      )}

      {attendees && attendees.length > 0 && (
        <MetadataRow icon={<Users />}>
          <section aria-label={t('metadata.attendees')} className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">
              {t('metadata.attendees-count', { count: attendees.length })}
            </h3>
            <ul className="max-h-40 space-y-1 overflow-y-auto">
              {attendees.map((attendee) => {
                const labelKey =
                  RESPONSE_LABEL_KEYS[attendee.responseStatus ?? 'needsAction'] ??
                  'metadata.response.needs-action'
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
                        {t('metadata.optional')}
                      </span>
                    )}
                    <span
                      className={cn('rounded-full px-2 py-0.5 text-[10px] font-medium', badgeStyle)}
                    >
                      {t(labelKey)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        </MetadataRow>
      )}

      {reminders && (
        <MetadataRow icon={<Bell />}>
          <section aria-label={t('metadata.reminders')} className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">{t('metadata.reminders')}</h3>
            {reminders.useDefault && reminders.overrides.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('metadata.default-reminders')}</p>
            ) : (
              <ul className="flex flex-wrap gap-1">
                {reminders.overrides.map((o, idx) => (
                  <li
                    key={`${o.method}-${o.minutes}-${idx}`}
                    className="rounded-md bg-muted px-2 py-0.5 text-xs"
                  >
                    {o.minutes} {tPhaseF('phaseF.componentsCalendarCalendarEventMetadata.min')}
                    {o.method}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </MetadataRow>
      )}

      {visibility && visibility !== 'default' && (
        <MetadataRow icon={<Lock />}>
          <section aria-label={t('metadata.visibility')} className="flex items-center gap-1">
            <span className="text-muted-foreground">{t('metadata.visibility')}</span>
            <span className="font-medium text-foreground">
              {t(VISIBILITY_LABEL_KEYS[visibility])}
            </span>
          </section>
        </MetadataRow>
      )}
    </CalendarCardSection>
  )
}

export default CalendarEventMetadata
