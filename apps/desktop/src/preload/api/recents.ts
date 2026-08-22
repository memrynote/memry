import { RecentsChannels } from '@memry/contracts/ipc-channels'
import type { RecordRecentlyOpenedInput } from '@memry/contracts/recents-api'
import { invoke } from '../lib/ipc'

export const recentsApi = {
  record: (input: RecordRecentlyOpenedInput) => invoke(RecentsChannels.invoke.RECORD, input),
  list: (limit?: number) => invoke(RecentsChannels.invoke.LIST, { limit })
}
