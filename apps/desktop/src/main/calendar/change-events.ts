import { BrowserWindow } from 'electron'
import type { CalendarChangedEvent } from '@memry/contracts/calendar-api'
import { CalendarChannels } from '@memry/contracts/ipc-channels'

export function emitCalendarChanged(event: CalendarChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(CalendarChannels.events.CHANGED, event)
  }
}

export function emitCalendarProjectionChanged(id: string): void {
  emitCalendarChanged({
    entityType: 'projection',
    id
  })
}
