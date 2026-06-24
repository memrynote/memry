import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import { invoke } from '../lib/ipc'
import type { HomePage } from '@memry/contracts/home-page-api'

export const homePagesApi = {
  list: (): Promise<HomePage[]> => invoke(HomePagesChannels.LIST),
  get: (id: string): Promise<HomePage | null> => invoke(HomePagesChannels.GET, id),
  create: (input: {
    name: string
    icon?: string
    position?: number
    widgets?: HomePage['widgets']
  }): Promise<HomePage> => invoke(HomePagesChannels.CREATE, input),
  update: (input: {
    id: string
    name?: string
    icon?: string
    position?: number
    widgets?: HomePage['widgets']
  }): Promise<HomePage> => invoke(HomePagesChannels.UPDATE, input),
  delete: (id: string): Promise<{ success: boolean }> => invoke(HomePagesChannels.DELETE, id),
  reorder: (ids: string[]): Promise<{ success: boolean }> =>
    invoke(HomePagesChannels.REORDER, { ids })
}
