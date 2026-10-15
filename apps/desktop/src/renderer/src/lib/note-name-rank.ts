import { nameKey } from '@memry/shared/note-names'
import { noteLinkStem } from '@memry/shared/wiki-target'
import { fuzzySearch } from './fuzzy-search'

export interface NamedNote {
  id: string
  title: string
  path: string
  aliases?: readonly string[]
}

export interface NoteNameMatch<T extends NamedNote> {
  note: T
  name: string | null
}

export function rankNoteNames<T extends NamedNote>(
  query: string,
  notes: readonly T[]
): NoteNameMatch<T>[] {
  if (query.trim() === '') return notes.map((note) => ({ note, name: null }))

  const entries = notes.flatMap((note) => [
    { note, name: null as string | null, text: note.title },
    ...(note.aliases ?? []).map((alias) => ({ note, name: alias as string | null, text: alias }))
  ])
  const key = nameKey(query)
  const exactTitles = entries.filter((e) => e.name === null && nameKey(e.text) === key)
  const exactNames = entries.filter((e) => e.name !== null && nameKey(e.text) === key)
  const ranked = [...exactTitles, ...exactNames, ...fuzzySearch(entries, query.trim(), ['text'])]

  const seen = new Set<string>()
  const matches: NoteNameMatch<T>[] = []
  for (const { note, name } of ranked) {
    if (seen.has(note.id)) continue
    seen.add(note.id)
    matches.push({ note, name })
  }
  return matches
}

export function isExactMatch(query: string, match: NoteNameMatch<NamedNote>): boolean {
  const key = nameKey(query)
  return key !== null && nameKey(match.name ?? match.note.title) === key
}

export function sharedTitles(notes: readonly NamedNote[]): Set<string> {
  const counts = new Map<string, number>()
  for (const note of notes) {
    const title = note.title.toLowerCase()
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([title]) => title))
}

export function sharedNames(notes: readonly NamedNote[]): Set<string> {
  const counts = new Map<string, number>()
  for (const note of notes) {
    for (const alias of new Set((note.aliases ?? []).map(nameKey))) {
      if (alias !== null) counts.set(alias, (counts.get(alias) ?? 0) + 1)
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key))
}

/**
 * What a link to `note` writes: its title, or, when another note shares that
 * title, its vault-root path stem (`Work/Plan`, `/Plan` at the root), which
 * the resolver reads as a path (#2562).
 */
export function linkTargetFor(note: NamedNote, shared: Set<string>): string {
  if (!shared.has(note.title.toLowerCase())) return note.title
  const stem = noteLinkStem(note.path)
  return stem.includes('/') ? stem : `/${stem}`
}

/** The folder a duplicate-titled row shows so the two rows can be told apart. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '/' : path.slice(0, slash)
}
