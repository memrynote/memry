import type { TelemetryEventName } from '@memry/contracts/telemetry-api'

import { trackMainEvent } from '../telemetry/track'

type CalendarTelemetryName = Extract<
  TelemetryEventName,
  | 'calendar_event_created'
  | 'calendar_event_updated'
  | 'calendar_google_connected'
  | 'calendar_google_sync_completed'
>

export const trackCalendar = (
  name: CalendarTelemetryName,
  action: string,
  source?: string,
  metrics?: { itemCount?: number }
): void =>
  trackMainEvent(name, {
    surface: 'calendar',
    action,
    source,
    result: 'success',
    metrics
  })
