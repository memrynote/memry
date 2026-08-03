import type { CalendarChangedEvent } from '@memry/contracts/calendar-api'
import { CalendarChannels } from '@memry/contracts/ipc-channels'

import { broadcastToAllWindows } from '../lib/window-broadcast'

export function emitCalendarChanged(event: CalendarChangedEvent): void {
  broadcastToAllWindows(CalendarChannels.events.CHANGED, event)
}

export function emitCalendarProjectionChanged(id: string): void {
  emitCalendarChanged({
    entityType: 'projection',
    id
  })
}
