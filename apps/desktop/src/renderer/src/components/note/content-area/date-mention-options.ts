import { type RemindOffset } from '@memry/shared/date-mention'

// The Remind option list is dynamic on `hasTime` — matching Notion. With no
// time, sub-hour offsets are meaningless and "at" reads as "On day of event".
export function remindOptions(
  hasTime: boolean
): ReadonlyArray<{ value: RemindOffset; label: string }> {
  if (!hasTime) {
    return [
      { value: 'none', label: 'None' },
      { value: 'at', label: 'On day of event (09:00)' },
      { value: '1d', label: '1 day before (09:00)' },
      { value: '2d', label: '2 days before (09:00)' },
      { value: '1w', label: '1 week before (09:00)' }
    ]
  }
  return [
    { value: 'none', label: 'None' },
    { value: 'at', label: 'At time of event' },
    { value: '5m', label: '5 minutes before' },
    { value: '10m', label: '10 minutes before' },
    { value: '15m', label: '15 minutes before' },
    { value: '30m', label: '30 minutes before' },
    { value: '1h', label: '1 hour before' },
    { value: '2h', label: '2 hours before' },
    { value: '1d', label: '1 day before (09:00)' },
    { value: '2d', label: '2 days before (09:00)' },
    { value: '1w', label: '1 week before (09:00)' }
  ]
}
