import { JournalChannels } from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'

export const journalApi = {
  getEntry: (date: string) => invoke(JournalChannels.invoke.GET_ENTRY, { date }),
  createEntry: (input: { date: string; content?: string; tags?: string[] }) =>
    invoke(JournalChannels.invoke.CREATE_ENTRY, input),
  updateEntry: (input: { date: string; content?: string; tags?: string[] }) =>
    invoke(JournalChannels.invoke.UPDATE_ENTRY, input),
  deleteEntry: (date: string) => invoke(JournalChannels.invoke.DELETE_ENTRY, { date }),

  getHeatmap: (year: number) => invoke(JournalChannels.invoke.GET_HEATMAP, { year }),
  getMonthEntries: (year: number, month: number) =>
    invoke(JournalChannels.invoke.GET_MONTH_ENTRIES, { year, month }),
  getYearStats: (year: number) => invoke(JournalChannels.invoke.GET_YEAR_STATS, { year }),

  getDayContext: (date: string) => invoke(JournalChannels.invoke.GET_DAY_CONTEXT, { date }),

  getAllTags: () => invoke(JournalChannels.invoke.GET_ALL_TAGS),

  getStreak: () => invoke(JournalChannels.invoke.GET_STREAK)
}

export const journalEvents = {
  onJournalEntryCreated: (
    callback: (event: { date: string; entry: unknown }) => void
  ): (() => void) =>
    subscribe<{ date: string; entry: unknown }>(JournalChannels.events.ENTRY_CREATED, callback),

  onJournalEntryUpdated: (
    callback: (event: { date: string; entry: unknown }) => void
  ): (() => void) =>
    subscribe<{ date: string; entry: unknown }>(JournalChannels.events.ENTRY_UPDATED, callback),

  onJournalEntryDeleted: (callback: (event: { date: string }) => void): (() => void) =>
    subscribe<{ date: string }>(JournalChannels.events.ENTRY_DELETED, callback),

  onJournalExternalChange: (
    callback: (event: { date: string; type: 'modified' | 'deleted' }) => void
  ): (() => void) =>
    subscribe<{ date: string; type: 'modified' | 'deleted' }>(
      JournalChannels.events.EXTERNAL_CHANGE,
      callback
    )
}
