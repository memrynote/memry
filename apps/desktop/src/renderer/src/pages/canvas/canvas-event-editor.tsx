/**
 * CanvasEventEditor — hosts the extracted <CalendarEventForm> for an active
 * event card on the spatial canvas (M6 Task 7, matrix #22 event). Owns the
 * CalendarEventDraft; seeds it from calendarService.getEvent (ISO times
 * converted to the form's local wall-clock strings, mirroring
 * pages/calendar.tsx's createDraftFromItem) and saves via
 * calendarService.updateEvent (draft converted back to ISO via the same
 * localInputToIso helper the calendar page uses in toCreatePayload).
 */
import React, { useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { CalendarEventForm } from '@/components/calendar/calendar-event-form'
import {
  localInputToIso,
  toLocalDateInputValue,
  toLocalDateTimeInputValue
} from '@/components/calendar/date-utils'
import type { CalendarEventDraft } from '@/components/calendar/types'
import { calendarService, type CalendarEventRecord } from '@/services/calendar-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { cn } from '@/lib/utils'

const log = createLogger('CanvasEventEditor')

interface CanvasEventEditorProps {
  eventId: string
  onDone: () => void
  /**
   * False on an idle card: the same form, mounted purely to paint — no
   * focus-on-mount (several cards would fight over focus and steal it from the
   * canvas) and natural height, with the card shell clipping + scrolling it.
   */
  interactive?: boolean
}

export function toDraft(event: CalendarEventRecord): CalendarEventDraft {
  return {
    title: event.title,
    description: event.description ?? '',
    isAllDay: event.isAllDay,
    startAt: event.isAllDay
      ? toLocalDateInputValue(event.startAt)
      : toLocalDateTimeInputValue(event.startAt),
    endAt: event.endAt
      ? event.isAllDay
        ? toLocalDateInputValue(event.endAt)
        : toLocalDateTimeInputValue(event.endAt)
      : '',
    targetCalendarId: event.targetCalendarId,
    projectId: null
  }
}

export const CanvasEventEditor = ({
  eventId,
  onDone,
  interactive = true
}: CanvasEventEditorProps): React.JSX.Element => {
  const [draft, setDraft] = useState<CalendarEventDraft | null>(null)
  const [isSaving, setSaving] = useState(false)
  const { t: tCommon } = useT('common')

  useEffect(() => {
    let cancelled = false
    calendarService
      .getEvent(eventId)
      .then((event) => {
        if (cancelled || !event) return
        setDraft(toDraft(event))
      })
      .catch((error: unknown) => {
        log.error('Failed to load calendar event', {
          eventId,
          error: extractErrorMessage(error)
        })
        trackRendererError('canvas_event_card_load', error)
      })
    return () => {
      cancelled = true
    }
  }, [eventId])

  const rootLayout = interactive ? 'min-h-0 flex-1 overflow-auto' : 'w-full'

  if (!draft) {
    return (
      <div className={cn('p-3 text-[13px] text-text-tertiary', rootLayout)}>
        {tCommon('state.loading')}
      </div>
    )
  }

  const onSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const result = await calendarService.updateEvent({
        id: eventId,
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        startAt: localInputToIso(draft.startAt, draft.isAllDay),
        endAt: draft.endAt ? localInputToIso(draft.endAt, draft.isAllDay) : null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        isAllDay: draft.isAllDay,
        targetCalendarId: draft.targetCalendarId
      })
      if (!result.success) {
        throw new Error(result.error ?? 'Could not save event.')
      }
      onDone()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={cn('p-3', rootLayout)}>
      <CalendarEventForm
        mode="edit"
        autoFocus={interactive}
        draft={draft}
        isSaving={isSaving}
        onDraftChange={setDraft}
        onSave={onSave}
        onDismiss={onDone}
      />
    </div>
  )
}
