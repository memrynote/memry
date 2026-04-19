import type { FieldClocks } from '@memry/contracts/sync-api'
import { mergeFields, type MergeResult } from '../sync/field-merge'

export const CALENDAR_EVENT_SYNCABLE_FIELDS = [
  'title',
  'description',
  'location',
  'startAt',
  'endAt',
  'timezone',
  'isAllDay',
  'recurrenceRule',
  'recurrenceExceptions',
  'attendees',
  'reminders',
  'visibility',
  'colorId',
  'conferenceData'
] as const

export function mergeCalendarEventFields(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  localFC: FieldClocks,
  remoteFC: FieldClocks
): MergeResult<Record<string, unknown>> {
  return mergeFields(local, remote, localFC, remoteFC, CALENDAR_EVENT_SYNCABLE_FIELDS)
}
