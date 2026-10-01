import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SelectOption, StatusCategories } from '@memry/contracts/property-types'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { journalService } from '@/services/journal-service'
import { journalKeys, ENTRY_GC_TIME, ENTRY_STALE_TIME } from '@/hooks/journal-query-keys'
import { usePropertyDefinitions } from '@/hooks/use-property-definitions'
import { extractErrorMessage } from '@/lib/ipc-error'
import { addDays, dayOfValue, localDayKey, type ChartRow } from '@/lib/property-chart/chart-model'

/** A property the chart settings can offer, with the type that picks its chart. */
export interface ChartPropertyOption {
  name: string
  type: string
}

export interface ChartData {
  rows: ChartRow[]
  properties: ChartPropertyOption[]
  isLoading: boolean
  error: string | null
}

/** Today's day key. Read on each render, so a chart left open past midnight moves on. */
export function useToday(): string {
  return localDayKey(new Date())
}

/**
 * The journal's rows for a chart: the range and the same length before it,
 * for the "vs previous" figure.
 */
export function useJournalChartData(today: string, rangeDays: number): ChartData {
  const from = addDays(today, -(rangeDays * 2 - 1))
  const query = useQuery({
    queryKey: journalKeys.propertyRowsForRange(from, today),
    queryFn: () => journalService.getPropertyRows(from, today),
    staleTime: ENTRY_STALE_TIME,
    gcTime: ENTRY_GC_TIME
  })
  const rows = useMemo<ChartRow[]>(
    () =>
      (query.data?.rows ?? []).map((row) => ({
        id: row.id,
        day: row.date,
        properties: row.properties
      })),
    [query.data]
  )
  return {
    rows,
    properties: query.data?.properties ?? [],
    isLoading: query.isLoading,
    error: query.error ? extractErrorMessage(query.error) : null
  }
}

/**
 * A folder or tag's notes as chart rows, each on the day `dateFrom` names:
 * `created`, `modified` or a date property. A note without that day is left
 * out of the chart.
 */
export function notesToChartRows(notes: NoteWithProperties[], dateFrom: string): ChartRow[] {
  return notes.map((note) => ({
    id: note.id,
    day: dayOfValue(
      dateFrom === 'created'
        ? note.created
        : dateFrom === 'modified'
          ? note.modified
          : note.properties[dateFrom]
    ),
    properties: note.properties
  }))
}

/** A select, multi-select or status property's colour per value. */
export function useOptionColors(property: string | undefined): ReadonlyMap<string, string> {
  const { getDefinition } = usePropertyDefinitions()
  const options = property ? getDefinition(property)?.options : undefined
  return useMemo(() => {
    const colors = new Map<string, string>()
    if (!options) return colors
    let parsed: unknown
    try {
      parsed = JSON.parse(options)
    } catch {
      return colors
    }
    const add = (list: unknown): void => {
      if (!Array.isArray(list)) return
      for (const option of list as SelectOption[]) {
        if (typeof option?.value === 'string' && typeof option.color === 'string') {
          colors.set(option.value, option.color)
        }
      }
    }
    add(parsed)
    const categories = (parsed as { categories?: StatusCategories } | null)?.categories
    if (categories) for (const category of Object.values(categories)) add(category?.options)
    return colors
  }, [options])
}
