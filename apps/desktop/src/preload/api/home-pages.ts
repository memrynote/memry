import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type { HomePage } from '@memry/contracts/home-page-api'

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
    invoke(HomePagesChannels.invoke.REORDER, { ids })
}

export const homePagesEvents = {
  onHomePageCreated: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(HomePagesChannels.events.CREATED, callback),

  onHomePageUpdated: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(HomePagesChannels.events.UPDATED, callback),

  onHomePageDeleted: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(HomePagesChannels.events.DELETED, callback)
}
