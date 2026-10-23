import {
  FoldChannels,
  type FoldAgentStatus,
  type FoldLastRun,
  type FoldLayers
} from '@memry/contracts/note-fold'
import { invoke, subscribe } from '../lib/ipc'

export const noteFoldApi = {
  get: (noteId: string): Promise<FoldLayers> => invoke(FoldChannels.invoke.GET, { noteId }),
  /** No noteId retries the last failed note; null when there is nothing to retry. */
  retry: (noteId?: string): Promise<FoldLayers | null> =>
    invoke(FoldChannels.invoke.RETRY, { noteId }),
  getLastRun: (): Promise<FoldLastRun> => invoke(FoldChannels.invoke.LAST_RUN),
  getAgentStatus: (): Promise<FoldAgentStatus> => invoke(FoldChannels.invoke.AGENT_STATUS),
  onUpdated: (callback: (event: { noteId: string }) => void): (() => void) =>
    subscribe<{ noteId: string }>(FoldChannels.events.UPDATED, callback)
}
