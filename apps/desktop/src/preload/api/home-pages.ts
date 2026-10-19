import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type {
  HomePage,
  HomePageCoverSource,
  HomePageSetCoverResult
} from '@memry/contracts/home-page-api'
import type { CoverFraming } from '@memry/shared/cover-image'

export const homePagesApi = {
  list: (): Promise<HomePage[]> => invoke(HomePagesChannels.invoke.LIST),
  get: (id: string): Promise<HomePage | null> => invoke(HomePagesChannels.invoke.GET, id),
  create: (input: {
    name: string
    icon?: string
    position?: number
    widgets?: HomePage['widgets']
  }): Promise<HomePage> => invoke(HomePagesChannels.invoke.CREATE, input),
  update: (input: {
    id: string
    name?: string
    icon?: string
    position?: number
    widgets?: HomePage['widgets']
  }): Promise<HomePage> => invoke(HomePagesChannels.invoke.UPDATE, input),
  delete: (id: string): Promise<{ success: boolean }> =>
    invoke(HomePagesChannels.invoke.DELETE, id),
  reorder: (ids: string[]): Promise<{ success: boolean }> =>
    invoke(HomePagesChannels.invoke.REORDER, { ids }),
  setCover: (id: string, source: HomePageCoverSource): Promise<HomePageSetCoverResult> =>
    invoke(HomePagesChannels.invoke.SET_COVER, { id, source }),
  setCoverFraming: (id: string, changes: Partial<CoverFraming>): Promise<HomePage> =>
    invoke(HomePagesChannels.invoke.SET_COVER_FRAMING, { id, changes }),
  removeCover: (id: string): Promise<HomePage> => invoke(HomePagesChannels.invoke.REMOVE_COVER, id),
  materializeCover: (id: string): Promise<{ success: boolean }> =>
    invoke(HomePagesChannels.invoke.MATERIALIZE_COVER, id)
}

export const homePagesEvents = {
  onHomePageCreated: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(HomePagesChannels.events.CREATED, callback),

  onHomePageUpdated: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(HomePagesChannels.events.UPDATED, callback),

  onHomePageDeleted: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(HomePagesChannels.events.DELETED, callback)
}
