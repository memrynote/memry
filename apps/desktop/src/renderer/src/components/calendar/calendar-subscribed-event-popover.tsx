import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useT } from '@memry/i18n/renderer'
import type {
  CalendarEventAttendeeRecord,
  CalendarEventConferenceDataRecord,
  CalendarExternalEventDetails
} from '@memry/contracts/calendar-api'

import {
  AlignLeft,
  Bell,
  CalendarDays,
  CheckCircle,
  HelpCircle,
  MapPin,
  Phone,
  Repeat,
  Users,
  Video,
  X,
  XCircle
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  describeRecurrence,
  splitLinks,
  stripConferenceBoilerplate
} from '@/lib/calendar-event-text'
import { calendarService, type CalendarProjectionItem } from '@/services/calendar-service'

import type { AnchorRect } from './types'
import { useAnchoredPopoverPosition } from './popover-position'
import {
  CALENDAR_CARD_CLASS,
  CARD_ICON_BUTTON_CLASS,
  CalendarCardHeader,
  CalendarCardSection
} from './calendar-card'

const log = createLogger('CalendarReadOnlyEventCard')

const DAY_MS = 24 * 60 * 60 * 1000
const CARD_WIDTH = 340
const ATTENDEES_COLLAPSED = 6

interface SubscribedEventTarget {
  item: CalendarProjectionItem
  anchorRect: AnchorRect
}

function whenLabel(item: CalendarProjectionItem, locale: string): string {
  const start = new Date(item.startAt)
  if (item.isAllDay) {
    // All-day items are stored at UTC midnight with an exclusive end.
    const format = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC'
    })
    const lastDay = item.endAt ? new Date(new Date(item.endAt).getTime() - DAY_MS) : start
    return lastDay > start ? format.formatRange(start, lastDay) : format.format(start)
  }
  const format = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })
  return item.endAt ? format.formatRange(start, new Date(item.endAt)) : format.format(start)
}

/** A card row: a fixed 16px icon lane, then the content. Same lane as the event form. */
function Row({
  icon,
  children,
  className
}: {
  icon: ReactNode
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex min-h-8 items-start gap-2.5 px-3.5 py-1.5', className)}>
      <span
        aria-hidden
        className="flex w-4 shrink-0 justify-center pt-0.5 text-muted-foreground [&_svg]:size-4"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-[13px]/5">{children}</div>
    </div>
  )
}

/** Text with its http(s) links clickable. */
function LinkedText({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {splitLinks(text).map((part, index) =>
        part.kind === 'link' ? (
          <a
            key={index}
            href={part.value}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-(--tint-text) underline-offset-2 hover:underline"
          >
            {part.value}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        )
      )}
    </>
  )
}

function alertLabel(minutes: number, t: ReturnType<typeof useT>['t']): string {
  if (minutes > 0 && minutes % (24 * 60) === 0) {
    return t('subscribedEvent.alertDays', { days: minutes / (24 * 60) })
  }
  if (minutes > 0 && minutes % 60 === 0)
    return t('subscribedEvent.alertHours', { hours: minutes / 60 })
  return t('subscribedEvent.alert', { minutes })
}

function videoEntry(conference: CalendarEventConferenceDataRecord | null): string | null {
  return (
    conference?.entryPoints?.find((entry) => entry.entryPointType === 'video' && entry.uri)?.uri ??
    null
  )
}

/** `tel:+1-204-555-0100;714957213#` → number and PIN, for display. */
function phoneEntry(
  conference: CalendarEventConferenceDataRecord | null
): { number: string; pin: string | null } | null {
  const uri = conference?.entryPoints?.find((entry) => entry.entryPointType === 'phone')?.uri
  if (!uri) return null
  const [number, pin] = uri.replace(/^tel:/i, '').split(';')
  return number ? { number, pin: pin ?? null } : null
}

function ResponseIcon({ status }: { status: CalendarEventAttendeeRecord['responseStatus'] }) {
  if (status === 'accepted') {
    return <CheckCircle className="size-4 text-emerald-600 dark:text-emerald-400" />
  }
  if (status === 'declined') return <XCircle className="size-4 text-rose-600 dark:text-rose-400" />
  if (status === 'tentative') {
    return <HelpCircle className="size-4 text-amber-600 dark:text-amber-400" />
  }
  return <HelpCircle className="size-4 text-muted-foreground" />
}

function AttendeeList({ attendees }: { attendees: CalendarEventAttendeeRecord[] }) {
  const { t } = useT('calendar')
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? attendees : attendees.slice(0, ATTENDEES_COLLAPSED)
  return (
    <section aria-label={t('metadata.attendees')} className="grid gap-1">
      <h4 className="text-xs font-medium text-muted-foreground">
        {t('metadata.attendees-count', { count: attendees.length })}
      </h4>
      <ul className="grid gap-1">
        {visible.map((attendee, index) => {
          const label = attendee.displayName || attendee.email
          const responseKey =
            attendee.responseStatus === 'needsAction' || !attendee.responseStatus
              ? 'needs-action'
              : attendee.responseStatus
          return (
            <li
              key={`${attendee.email}-${index}`}
              className="flex min-w-0 items-center gap-2"
              title={attendee.email || undefined}
            >
              <span
                role="img"
                aria-label={t(`metadata.response.${responseKey}`)}
                className="flex shrink-0"
              >
                <ResponseIcon status={attendee.responseStatus} />
              </span>
              <span className="min-w-0 truncate text-foreground">{label}</span>
              {(attendee.organizer || attendee.self) && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {[
                    attendee.organizer ? t('subscribedEvent.organizer') : null,
                    attendee.self ? t('subscribedEvent.you') : null
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {attendees.length > ATTENDEES_COLLAPSED && (
        <button
          type="button"
          className="w-fit text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-(--tint-ring)"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? t('subscribedEvent.showLess') : t('subscribedEvent.showMore')}
        </button>
      )}
    </section>
  )
}

/**
 * The card for an event memrynote can only read (a subscribed feed, a macOS
 * calendar). It opens straight away from the projection item, then fills in
 * attendees, the join link, alerts and the series rule from the mirror.
 */
function SubscribedEventPopover({
  item,
  anchorRect,
  onDismiss
}: SubscribedEventTarget & { onDismiss: () => void }): React.JSX.Element {
  const { t, i18n } = useT('calendar')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const { ref: positionRef, style: positionStyle } = useAnchoredPopoverPosition(anchorRect, {
    width: CARD_WIDTH,
    estimatedHeight: 360
  })
  const setContainer = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node
      positionRef(node)
    },
    [positionRef]
  )

  const detailsQuery = useQuery({
    queryKey: ['calendar', 'external-event', item.sourceId],
    queryFn: async (): Promise<CalendarExternalEventDetails | null> =>
      (await calendarService.getExternalEvent({ externalEventId: item.sourceId })).event
  })
  useEffect(() => {
    if (detailsQuery.error) log.warn('Could not load event details', detailsQuery.error)
  }, [detailsQuery.error])
  const details = detailsQuery.data ?? null

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return
      onDismiss()
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onDismiss()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])

  const isMac = item.source.provider === 'apple-eventkit'
  const kindLabel = isMac ? t('subscribedEvent.kindAppleEventKit') : t('subscribedEvent.kind')
  const accountTitle = details?.source?.accountTitle ?? null
  const headerLabel = [kindLabel, isMac ? accountTitle : item.source.title]
    .filter(Boolean)
    .join(' · ')
  const dotColor = item.displayColor ?? item.source.color ?? 'var(--cal-indigo-rail)'

  const rrule =
    typeof details?.recurrenceRule?.rrule === 'string' ? details.recurrenceRule.rrule : null
  const recurrence = rrule ? describeRecurrence(rrule, i18n.language) : null
  const alerts = details?.reminders?.overrides ?? []
  const conference = details?.conferenceData ?? null
  const joinUrl = videoEntry(conference)
  const phone = phoneEntry(conference)
  const location =
    details?.location && (!joinUrl || !details.location.includes(joinUrl)) ? details.location : null
  const description = details
    ? details.description
      ? stripConferenceBoilerplate(details.description)
      : ''
    : (item.descriptionPreview ?? '')
  const attendees = details?.attendees ?? []

  return (
    <div
      ref={setContainer}
      role="dialog"
      aria-label={kindLabel}
      data-testid="calendar-subscribed-event-popover"
      style={positionStyle}
      className={CALENDAR_CARD_CLASS}
    >
      <CalendarCardHeader
        dotStyle={{ backgroundColor: dotColor }}
        label={headerLabel}
        actions={
          <button
            type="button"
            className={CARD_ICON_BUTTON_CLASS}
            aria-label={t('subscribedEvent.close')}
            title={t('subscribedEvent.close')}
            onClick={onDismiss}
          >
            <X className="size-3.5" />
          </button>
        }
      />

      <div className="flex flex-col gap-1 px-3.5 pb-3">
        <h3 className="text-[15px]/5 font-semibold text-foreground">{item.title}</h3>
        <p className="text-xs text-muted-foreground">{whenLabel(item, i18n.language)}</p>
      </div>

      {(recurrence || alerts.length > 0) && (
        <CalendarCardSection className="py-1.5">
          {recurrence && (
            <Row icon={<Repeat />}>
              {t(`subscribedEvent.recurrence.${recurrence.key}`, {
                count: recurrence.count,
                days: recurrence.days ?? ''
              })}
            </Row>
          )}
          {alerts.length > 0 && (
            <Row icon={<Bell />}>
              {alerts.map((alert) => alertLabel(alert.minutes, t)).join(', ')}
            </Row>
          )}
        </CalendarCardSection>
      )}

      {(joinUrl || phone) && (
        <CalendarCardSection className="py-1.5" data-testid="calendar-read-only-join">
          {joinUrl && (
            <Row icon={<Video />} className="items-center">
              <div className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-foreground">
                    {conference?.conferenceSolution?.name ?? t('metadata.video-call')}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {joinUrl.replace(/^https:\/\//, '').replace(/\?.*$/, '')}
                  </span>
                </div>
                <a
                  href={joinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-6 shrink-0 items-center rounded-md bg-(--cal-indigo-solid) px-2.5 text-xs font-semibold text-(--cal-indigo-solid-ink) outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--tint-ring)"
                >
                  {t('metadata.join-meeting')}
                </a>
              </div>
            </Row>
          )}
          {phone && (
            <Row icon={<Phone />}>
              <span className="text-muted-foreground">{t('subscribedEvent.phone')}</span>{' '}
              <span className="select-text text-foreground">
                {phone.number}
                {phone.pin ? ` · PIN ${phone.pin}` : ''}
              </span>
            </Row>
          )}
        </CalendarCardSection>
      )}

      {location && (
        <CalendarCardSection className="py-1.5">
          <Row icon={<MapPin />}>
            <span className="break-words text-foreground">
              <LinkedText text={location} />
            </span>
          </Row>
        </CalendarCardSection>
      )}

      {attendees.length > 0 && (
        <CalendarCardSection className="py-1.5">
          <Row icon={<Users />}>
            <AttendeeList attendees={attendees} />
          </Row>
        </CalendarCardSection>
      )}

      <CalendarCardSection className="py-1.5">
        <Row icon={<CalendarDays />} className="items-center">
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: dotColor }}
            />
            <span className="truncate text-foreground">
              {details?.source?.title ?? item.source.title}
            </span>
          </span>
        </Row>
      </CalendarCardSection>

      {description && (
        <CalendarCardSection className="py-1.5">
          <Row icon={<AlignLeft />}>
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-foreground select-text">
              <LinkedText text={description} />
            </p>
          </Row>
        </CalendarCardSection>
      )}

      {detailsQuery.error && (
        <p role="alert" className="border-t border-border/70 px-3.5 py-2 text-xs text-destructive">
          {extractErrorMessage(detailsQuery.error, t('subscribedEvent.detailsFailed'))}
        </p>
      )}
    </div>
  )
}

/** Renders nothing until a read-only event is selected. */
export function CalendarSubscribedEventPopover({
  target,
  onDismiss
}: {
  target: SubscribedEventTarget | null
  onDismiss: () => void
}): React.JSX.Element | null {
  return target ? <SubscribedEventPopover {...target} onDismiss={onDismiss} /> : null
}

export default CalendarSubscribedEventPopover
