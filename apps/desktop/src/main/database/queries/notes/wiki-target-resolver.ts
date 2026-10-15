import { and, eq, inArray, sql } from 'drizzle-orm'
import { noteCache, noteNames, type NoteCache } from '@memry/db-schema/schema/notes-cache'
import {
  nameKey,
  pickWikiTarget,
  type WikiMatch,
  type WikiNameCandidate
} from '@memry/shared/note-names'
import { foldTag } from '@memry/shared/tag-fold'
import { wikiPathStem } from '@memry/shared/wiki-target'
import type { IndexDb } from '../../types'

const CHUNK = 500

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK))
  return out
}

function candidatesFor(db: IndexDb, queries: readonly string[]): WikiNameCandidate[] {
  const keys = [...new Set(queries.map(nameKey).filter((key) => key !== null))]
  const pathForms = [
    ...new Set(
      queries.flatMap((query) => {
        const stem = wikiPathStem(query)
        return stem === null ? [] : [foldTag(stem), foldTag(`${stem}.md`)]
      })
    )
  ]

  const ids = new Set<string>()
  for (const batch of chunks(keys)) {
    for (const row of db
      .selectDistinct({ noteId: noteNames.noteId })
      .from(noteNames)
      .where(inArray(noteNames.key, batch))
      .all())
      ids.add(row.noteId)
  }
  for (const batch of chunks(pathForms)) {
    for (const row of db
      .select({ id: noteCache.id })
      .from(noteCache)
      .where(inArray(sql`tag_fold(${noteCache.path})`, batch))
      .all())
      ids.add(row.id)
  }
  if (ids.size === 0) return []

  const candidates: WikiNameCandidate[] = []
  for (const batch of chunks([...ids])) {
    const aliases = new Map<string, string[]>()
    for (const row of db
      .select({ noteId: noteNames.noteId, display: noteNames.display })
      .from(noteNames)
      .where(and(inArray(noteNames.noteId, batch), eq(noteNames.kind, 'alias')))
      .all()) {
      aliases.set(row.noteId, [...(aliases.get(row.noteId) ?? []), row.display])
    }
    for (const note of db
      .select({
        id: noteCache.id,
        path: noteCache.path,
        title: noteCache.title,
        date: noteCache.date
      })
      .from(noteCache)
      .where(inArray(noteCache.id, batch))
      .all()) {
      candidates.push({
        noteId: note.id,
        path: note.path,
        title: note.title,
        aliases: aliases.get(note.id) ?? [],
        journal: note.date !== null
      })
    }
  }
  return candidates
}

export function resolveLinkTargets(
  db: IndexDb,
  queries: readonly string[]
): Map<string, WikiMatch | null> {
  const distinct = [...new Set(queries)]
  const candidates = candidatesFor(db, distinct)
  return new Map(distinct.map((query) => [query, pickWikiTarget(query, candidates)]))
}

export interface ResolvedLinkTarget {
  note: NoteCache
  matchedBy: WikiMatch['matchedBy']
}

export function resolveLinkTarget(db: IndexDb, query: string): ResolvedLinkTarget | undefined {
  const match = resolveLinkTargets(db, [query]).get(query)
  if (!match) return undefined
  const note = db.select().from(noteCache).where(eq(noteCache.id, match.noteId)).get()
  return note && { note, matchedBy: match.matchedBy }
}
