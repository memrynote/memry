// Mirrors desktop's `journal:getPropertyRows` (getJournalPropertyRows in
// apps/desktop/src/main/database/queries/notes/journal-queries.ts), reading the journal files
// instead of the index so a CLI-written entry is included before desktop has indexed it.
import { PROJECT_PROPERTY_KEY, type PropertyType } from '@memry/contracts/property-types'
import { isRelationValue } from '@memry/contracts/relation-uri'
import type { NotesService } from './notes.ts'
import type { PropertiesService } from './properties.ts'

export interface JournalPropertyRow {
  id: string
  date: string
  path: string
  title: string
  properties: Record<string, unknown>
}

export interface JournalPropertySummary {
  name: string
  type: string
  count: number
}

const journalDatePattern = /^\d{4}-\d{2}-\d{2}$/

// apps/desktop/src/main/vault/property-type.ts `inferPropertyType`.
function inferPropertyType(name: string, value: unknown): PropertyType {
  if (name === PROJECT_PROPERTY_KEY) return 'project'
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (value instanceof Date) return 'date'
  if (isRelationValue(value)) return 'relation'
  if (Array.isArray(value)) return 'text'
  if (typeof value === 'string') {
    if (
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/.test(value) &&
      !Number.isNaN(new Date(value).getTime())
    ) {
      return 'date'
    }
    try {
      const url = new URL(value)
      if (url.protocol === 'http:' || url.protocol === 'https:') return 'url'
    } catch {
      // Not a URL.
    }
  }
  return 'text'
}

export async function journalPropertyRows(
  { notes, properties }: { notes: NotesService; properties: PropertiesService },
  from: string,
  to: string
): Promise<{ rows: JournalPropertyRow[]; properties: JournalPropertySummary[] }> {
  for (const [label, value] of [
    ['from', from],
    ['to', to]
  ]) {
    if (!journalDatePattern.test(value))
      throw new Error(`Invalid ${label} date (YYYY-MM-DD): ${value}`)
  }

  const entries = (await notes.list({ journalOnly: true, limit: 100000 }))
    .filter((entry) => entry.journalDate !== null)
    .toSorted((a, b) => a.journalDate!.localeCompare(b.journalDate!))
  const rows = entries
    .filter((entry) => entry.journalDate! >= from && entry.journalDate! <= to)
    .map((entry) => ({
      id: entry.id,
      date: entry.journalDate!,
      path: entry.path,
      title: entry.title,
      properties: entry.properties
    }))

  // The summary covers every journal entry, not just the range, as desktop's does.
  const byName = new Map<string, { total: number; types: Map<string, number> }>()
  for (const entry of entries) {
    for (const [name, value] of Object.entries(entry.properties)) {
      const seen = byName.get(name) ?? { total: 0, types: new Map<string, number>() }
      const type = inferPropertyType(name, value)
      seen.total += 1
      seen.types.set(type, (seen.types.get(type) ?? 0) + 1)
      byName.set(name, seen)
    }
  }
  const definedTypes = new Map((await properties.definitions()).map((d) => [d.name, d.type]))
  const summary = [...byName.entries()]
    .map(([name, { total, types }]) => ({
      name,
      type: definedTypes.get(name) ?? [...types.entries()].toSorted((a, b) => b[1] - a[1])[0][0],
      count: total
    }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return { rows, properties: summary }
}
