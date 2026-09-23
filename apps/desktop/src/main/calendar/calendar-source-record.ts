import type { CalendarSourceRecord } from '@memry/contracts/calendar-api'
import { calendarDisplayHex } from '@memry/contracts/calendar-colors'
import type { CalendarSource } from '@memry/db-schema/schema/calendar-sources'

export function mapCalendarSource(row: CalendarSource): CalendarSourceRecord {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    accountId: row.accountId ?? null,
    remoteId: row.remoteId,
    title: row.title,
    timezone: row.timezone ?? null,
    color: calendarDisplayHex(row.color),
    isPrimary: row.isPrimary,
    isSelected: row.isSelected,
    isMemryManaged: row.isMemryManaged,
    syncCursor: row.syncCursor ?? null,
    syncStatus: row.syncStatus,
    lastSyncedAt: row.lastSyncedAt ?? null,
    lastError: row.lastError ?? null,
    metadata: row.metadata ?? null,
    archivedAt: row.archivedAt ?? null,
    syncedAt: row.syncedAt ?? null,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}
