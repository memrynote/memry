export const ENTRY_STALE_TIME = 30 * 1000
export const ENTRY_GC_TIME = 5 * 60 * 1000
export const AUTO_SAVE_DELAY_MS = 1000
export const PREFETCH_DAYS = 1

export const journalKeys = {
  all: ['journal'] as const,
  entries: () => [...journalKeys.all, 'entries'] as const,
  entry: (date: string) => [...journalKeys.entries(), date] as const,
  heatmaps: () => [...journalKeys.all, 'heatmaps'] as const,
  heatmap: (year: number) => [...journalKeys.heatmaps(), year] as const,
  monthEntries: () => [...journalKeys.all, 'monthEntries'] as const,
  monthEntriesForMonth: (year: number, month: number) =>
    [...journalKeys.monthEntries(), year, month] as const,
  yearStats: () => [...journalKeys.all, 'yearStats'] as const,
  yearStatsForYear: (year: number) => [...journalKeys.yearStats(), year] as const,
  dayContext: () => [...journalKeys.all, 'dayContext'] as const,
  dayContextForDate: (date: string) => [...journalKeys.dayContext(), date] as const
}
