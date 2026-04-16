import { SearchChannels, GraphChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'

export const graphApi = {
  getData: () => invoke(GraphChannels.invoke.GET_GRAPH_DATA),
  getLocal: (params: { noteId: string; depth?: number }) =>
    invoke(GraphChannels.invoke.GET_LOCAL_GRAPH, params)
}

type SearchItemType = 'note' | 'journal' | 'task' | 'inbox'

export const searchApi = {
  query: (params: {
    text: string
    types?: SearchItemType[]
    tags?: string[]
    dateRange?: { from: string; to: string } | null
    projectId?: string | null
    folderPath?: string | null
    limit?: number
    offset?: number
  }) => invoke(SearchChannels.invoke.QUERY, params),
  quick: (text: string) => invoke(SearchChannels.invoke.QUICK, text),
  getStats: () => invoke(SearchChannels.invoke.GET_STATS),
  rebuildIndex: () => invoke(SearchChannels.invoke.REBUILD_INDEX),
  getReasons: () => invoke(SearchChannels.invoke.GET_REASONS),
  addReason: (params: {
    itemId: string
    itemType: SearchItemType
    itemTitle: string
    searchQuery: string
  }) => invoke(SearchChannels.invoke.ADD_REASON, params),
  clearReasons: () => invoke(SearchChannels.invoke.CLEAR_REASONS),
  getAllTags: () => invoke(SearchChannels.invoke.GET_ALL_TAGS)
}

export const searchEvents = {
  onSearchIndexRebuildStarted: (callback: () => void): (() => void) =>
    subscribe<void>(SearchChannels.events.INDEX_REBUILD_STARTED, () => callback()),

  onSearchIndexRebuildProgress: (
    callback: (progress: { phase: string; current: number; total: number; percent: number }) => void
  ): (() => void) =>
    subscribe<{ phase: string; current: number; total: number; percent: number }>(
      SearchChannels.events.INDEX_REBUILD_PROGRESS,
      callback
    ),

  onSearchIndexRebuildCompleted: (callback: () => void): (() => void) =>
    subscribe<void>(SearchChannels.events.INDEX_REBUILD_COMPLETED, () => callback()),

  onSearchIndexCorrupt: (callback: () => void): (() => void) =>
    subscribe<void>(SearchChannels.events.INDEX_CORRUPT, () => callback())
}
