import { RecentsChannels } from '@memry/contracts/ipc-channels'
import { invoke } from '../lib/ipc'

export const recentsApi = {
  record: (input: { itemId: string; itemType: 'note' }) =>
    invoke(RecentsChannels.invoke.RECORD, input),
  list: (limit?: number) => invoke(RecentsChannels.invoke.LIST, { limit })
}
