import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function syncFilterCreate(filterId: string): void {
  enqueueLocalSyncCreate('filter', filterId)
}

export function syncFilterUpdate(filterId: string): void {
  enqueueLocalSyncUpdate('filter', filterId)
}

export function syncFilterDelete(filterId: string, snapshot: string): void {
  enqueueLocalSyncDelete('filter', filterId, snapshot)
}
