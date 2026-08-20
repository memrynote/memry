import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function enqueueCustomIconCreate(iconId: string): void {
  enqueueLocalSyncCreate('custom_icon', iconId)
}

export function enqueueCustomIconUpdate(iconId: string): void {
  enqueueLocalSyncUpdate('custom_icon', iconId)
}

export function enqueueCustomIconDelete(iconId: string, snapshot?: unknown): void {
  if (!snapshot) return
  enqueueLocalSyncDelete('custom_icon', iconId, JSON.stringify(snapshot))
}
