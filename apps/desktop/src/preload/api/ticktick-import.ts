import { TickTickImportChannels } from '@memry/contracts/ipc-channels'
import { invoke } from '../lib/ipc'

export const tickTickImportApi = {
  /** Open a file picker and import a TickTick CSV backup. */
  run: () => invoke(TickTickImportChannels.invoke.RUN)
}
