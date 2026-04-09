import type { DataDb } from '../database'
import { getFilterSyncService } from '../sync/filter-sync'
import { incrementFilterClockOffline } from '../sync/offline-clock'

export function syncFilterCreate(db: DataDb, filterId: string): void {
  const svc = getFilterSyncService()
  if (svc) {
    svc.enqueueCreate(filterId)
  } else {
    incrementFilterClockOffline(db, filterId)
  }
}

export function syncFilterUpdate(db: DataDb, filterId: string): void {
  const svc = getFilterSyncService()
  if (svc) {
    svc.enqueueUpdate(filterId)
  } else {
    incrementFilterClockOffline(db, filterId)
  }
}

export function syncFilterDelete(filterId: string, snapshot: string): void {
  getFilterSyncService()?.enqueueDelete(filterId, snapshot)
}
