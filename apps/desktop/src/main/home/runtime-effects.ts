import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function enqueueHomePageCreate(boardId: string): void {
  enqueueLocalSyncCreate('home_page', boardId)
}

export function enqueueHomePageUpdate(boardId: string): void {
  enqueueLocalSyncUpdate('home_page', boardId)
}

export function enqueueHomePageDelete(boardId: string, snapshot?: unknown): void {
  if (!snapshot) return
  enqueueLocalSyncDelete('home_page', boardId, JSON.stringify(snapshot))
}
