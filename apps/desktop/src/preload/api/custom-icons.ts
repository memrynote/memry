import { CustomIconsChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type {
  CustomIcon,
  CustomIconAddInput,
  CustomIconAddFromUrlInput,
  CustomIconRenameInput
} from '@memry/contracts/custom-icons-api'

export const customIconsApi = {
  list: (): Promise<CustomIcon[]> => invoke(CustomIconsChannels.invoke.LIST),
  add: (input: CustomIconAddInput): Promise<CustomIcon> =>
    invoke(CustomIconsChannels.invoke.ADD, input),
  addFromUrl: (input: CustomIconAddFromUrlInput): Promise<CustomIcon> =>
    invoke(CustomIconsChannels.invoke.ADD_FROM_URL, input),
  rename: (input: CustomIconRenameInput): Promise<CustomIcon> =>
    invoke(CustomIconsChannels.invoke.RENAME, input),
  delete: (id: string): Promise<{ success: boolean }> =>
    invoke(CustomIconsChannels.invoke.DELETE, id)
}

export const customIconsEvents = {
  onCustomIconsUpdated: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(CustomIconsChannels.events.UPDATED, callback)
}
