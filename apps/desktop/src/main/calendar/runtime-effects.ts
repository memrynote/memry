import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function syncCalendarEventCreate(eventId: string): void {
  enqueueLocalSyncCreate('calendar_event', eventId)
}

export function syncCalendarEventUpdate(eventId: string): void {
  enqueueLocalSyncUpdate('calendar_event', eventId)
}

export function syncCalendarEventDelete(eventId: string, snapshot?: string): void {
  if (!snapshot) return
  enqueueLocalSyncDelete('calendar_event', eventId, snapshot)
}

export function syncCalendarSourceCreate(sourceId: string): void {
  enqueueLocalSyncCreate('calendar_source', sourceId)
}

export function syncCalendarSourceUpdate(sourceId: string): void {
  enqueueLocalSyncUpdate('calendar_source', sourceId)
}

export function syncCalendarSourceDelete(sourceId: string, snapshot?: string): void {
  enqueueLocalSyncDelete('calendar_source', sourceId, snapshot)
}

export function syncCalendarBindingCreate(bindingId: string): void {
  enqueueLocalSyncCreate('calendar_binding', bindingId)
}

export function syncCalendarBindingUpdate(bindingId: string): void {
  enqueueLocalSyncUpdate('calendar_binding', bindingId)
}

export function syncCalendarBindingDelete(bindingId: string, snapshot?: string): void {
  enqueueLocalSyncDelete('calendar_binding', bindingId, snapshot)
}

export function syncCalendarExternalEventCreate(eventId: string): void {
  enqueueLocalSyncCreate('calendar_external_event', eventId)
}

export function syncCalendarExternalEventUpdate(eventId: string): void {
  enqueueLocalSyncUpdate('calendar_external_event', eventId)
}

export function syncCalendarExternalEventDelete(eventId: string, snapshot?: string): void {
  enqueueLocalSyncDelete('calendar_external_event', eventId, snapshot)
}
