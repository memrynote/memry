import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getI18n } from 'react-i18next'
import { localInputToIso } from '@/components/calendar/date-utils'
import { taskBlockChange, type TaskBlockSchedule } from '@/components/calendar/task-block'
import type { CalendarEventDraft } from '@/components/calendar/types'
import { useUndoTracker } from '@/hooks/use-undo'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { calendarService, type CalendarProjectionItem } from '@/services/calendar-service'
import { tasksService } from '@/services/tasks-service'

const log = createLogger('CalendarGridActions')

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function toCreatePayload(draft: CalendarEventDraft) {
  return {
    title: draft.title.trim(),
    description: draft.description.trim() || null,
    startAt: localInputToIso(draft.startAt, draft.isAllDay),
    endAt: draft.endAt ? localInputToIso(draft.endAt, draft.isAllDay) : null,
    timezone: localTimezone(),
    isAllDay: draft.isAllDay,
    targetCalendarId: draft.targetCalendarId,
    color: draft.color
  }
}

/**
 * The writes behind a time grid's direct manipulation: moving or resizing a
 * block, and creating an event from a marquee. Shared by the Calendar page and
 * the Day Panel timeline so a block edited in either lands the same way.
 */
export function useCalendarGridActions(): {
  moveItem: (item: CalendarProjectionItem, startAt: string, endAt: string) => Promise<void>
  quickCreate: (draft: CalendarEventDraft) => Promise<void>
} {
  const queryClient = useQueryClient()
  const { registerUndo } = useUndoTracker()

  const refreshRanges = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['calendar', 'range'] }),
    [queryClient]
  )

  const commitTaskSchedule = useCallback(
    async (id: string, schedule: TaskBlockSchedule) => {
      const result = await tasksService.update({ id, ...schedule })
      if (!result.success) {
        throw new Error(result.error ?? 'Could not update task.')
      }
      await refreshRanges()
    },
    [refreshRanges]
  )

  const commitEventTimes = useCallback(
    async (id: string, startAt: string, endAt: string | null) => {
      const result = await calendarService.updateEvent({
        id,
        startAt,
        endAt,
        timezone: localTimezone(),
        isAllDay: false
      })
      if (!result.success) {
        throw new Error(result.error ?? 'Could not update event.')
      }
      await refreshRanges()
    },
    [refreshRanges]
  )

  const moveItem = useCallback(
    async (item: CalendarProjectionItem, startAt: string, endAt: string) => {
      const tCalendar = getI18n().getFixedT(null, 'calendar')
      if (item.sourceType === 'task') {
        const { next, previous } = taskBlockChange(item, startAt, endAt)
        try {
          await commitTaskSchedule(item.sourceId, next)
          registerUndo(tCalendar('undo.moveTask'), () => {
            void commitTaskSchedule(item.sourceId, previous).catch((err) => {
              log.error('Failed to undo task reschedule', {
                taskId: item.sourceId,
                error: extractErrorMessage(err)
              })
            })
          })
        } catch (err) {
          log.error('Failed to reschedule task', {
            taskId: item.sourceId,
            error: extractErrorMessage(err)
          })
        }
        return
      }

      try {
        await commitEventTimes(item.sourceId, startAt, endAt)
        registerUndo(tCalendar('undo.moveEvent'), () => {
          void commitEventTimes(item.sourceId, item.startAt, item.endAt).catch((err) => {
            log.error('Failed to undo calendar event move', {
              eventId: item.sourceId,
              error: extractErrorMessage(err)
            })
          })
        })
      } catch (err) {
        log.error('Failed to move calendar event', {
          eventId: item.sourceId,
          error: extractErrorMessage(err)
        })
      }
    },
    [commitEventTimes, commitTaskSchedule, registerUndo]
  )

  const quickCreate = useCallback(
    async (draft: CalendarEventDraft) => {
      const result = await calendarService.createEvent(toCreatePayload(draft))
      if (!result.success) {
        throw new Error(result.error ?? 'Could not create event.')
      }
      await refreshRanges()
    },
    [refreshRanges]
  )

  return { moveItem, quickCreate }
}
