import { and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm'
import { noteCache, noteLinks, noteNames, type NoteName } from '@memry/db-schema/schema/notes-cache'
import { nameKey, normalizeAliases, type NameKey } from '@memry/shared/note-names'
import { noteLinkStem } from '@memry/shared/wiki-target'
import type { IndexDb } from '../../types'
import { resolveLinkTargets } from './wiki-target-resolver'

export interface NoteNamesInput {
  noteId: string
  title: string
  aliases: readonly string[] | null
}

function nameRows(input: NoteNamesInput, keptAliases: readonly string[]): NoteName[] {
  const titleKey = nameKey(input.title)
  const rows: NoteName[] = titleKey
    ? [{ noteId: input.noteId, key: titleKey, display: input.title, kind: 'title' }]
    : []
  for (const alias of normalizeAliases(input.title, input.aliases ?? keptAliases)) {
    rows.push({
      noteId: input.noteId,
      key: nameKey(alias) as string,
      display: alias,
      kind: 'alias'
    })
  }
  return rows
}

export function reindexNoteNames(db: IndexDb, input: NoteNamesInput): NameKey[] {
  const before = db.select().from(noteNames).where(eq(noteNames.noteId, input.noteId)).all()
  const kept = before.filter((row) => row.kind === 'alias').map((row) => row.display)
  const after = nameRows(input, kept)
  const sig = (row: NoteName): string => `${row.kind}\u0000${row.key}\u0000${row.display}`
  const beforeSigs = new Set(before.map(sig))
  const afterSigs = new Set(after.map(sig))
  if (before.length === after.length && after.every((row) => beforeSigs.has(sig(row)))) return []

  db.delete(noteNames).where(eq(noteNames.noteId, input.noteId)).run()
  if (after.length > 0) db.insert(noteNames).values(after).run()
  const changed = new Set<string>()
  for (const row of before) if (!afterSigs.has(sig(row))) changed.add(row.key)
  for (const row of after) if (!beforeSigs.has(sig(row))) changed.add(row.key)
  return [...changed] as NameKey[]
}

export function deleteNoteNames(db: IndexDb, noteId: string): NameKey[] {
  const keys = db
    .select({ key: noteNames.key })
    .from(noteNames)
    .where(eq(noteNames.noteId, noteId))
    .all()
  db.delete(noteNames).where(eq(noteNames.noteId, noteId)).run()
  return keys.map((row) => row.key as NameKey)
}

export function getAliasesForNotes(db: IndexDb, noteIds: readonly string[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>()
  if (noteIds.length === 0) return aliases
  const rows = db
    .select({ noteId: noteNames.noteId, display: noteNames.display })
    .from(noteNames)
    .where(and(inArray(noteNames.noteId, [...noteIds]), eq(noteNames.kind, 'alias')))
    .orderBy(sql`rowid`)
    .all()
  for (const row of rows) {
    const list = aliases.get(row.noteId)
    if (list) list.push(row.display)
    else aliases.set(row.noteId, [row.display])
  }
  return aliases
}

export function pathLinkKeys(path: string): NameKey[] {
  const forms = [noteLinkStem(path), path].flatMap((form) => [form, `/${form}`])
  return [...new Set(forms.map(nameKey).filter((key) => key !== null))]
}

export interface ReresolvedLinks {
  sourceIds: string[]
  targetIds: string[]
}

export function reresolveLinks(db: IndexDb, keys: readonly string[]): ReresolvedLinks {
  const sourceIds = new Set<string>()
  const targetIds = new Set<string>()
  if (keys.length === 0) return { sourceIds: [], targetIds: [] }
  const distinctKeys = [...new Set(keys)]
  for (let i = 0; i < distinctKeys.length; i += 500) {
    const rows = db
      .select()
      .from(noteLinks)
      .where(inArray(noteLinks.targetKey, distinctKeys.slice(i, i + 500)))
      .all()
    const resolved = resolveLinkTargets(
      db,
      rows.map((row) => row.targetTitle)
    )
    for (const row of rows) {
      const targetId = resolved.get(row.targetTitle)?.noteId ?? null
      if (targetId === row.targetId) continue
      db.update(noteLinks)
        .set({ targetId })
        .where(
          and(eq(noteLinks.sourceId, row.sourceId), eq(noteLinks.targetTitle, row.targetTitle))
        )
        .run()
      sourceIds.add(row.sourceId)
      if (row.targetId) targetIds.add(row.targetId)
      if (targetId) targetIds.add(targetId)
    }
  }
  return { sourceIds: [...sourceIds], targetIds: [...targetIds] }
}

/** Notes indexed before index migration 0027, which have no name rows yet. */
export function listNotesWithoutNames(
  db: IndexDb
): Array<{ id: string; path: string; title: string; fileType: string }> {
  return db
    .select({
      id: noteCache.id,
      path: noteCache.path,
      title: noteCache.title,
      fileType: noteCache.fileType
    })
    .from(noteCache)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(noteNames)
          .where(eq(noteNames.noteId, noteCache.id))
      )
    )
    .all()
}

/** Fill `target_key` on link rows written before index migration 0027. Returns the keys filled. */
export function fillMissingLinkKeys(db: IndexDb): NameKey[] {
  const rows = db
    .select({ sourceId: noteLinks.sourceId, targetTitle: noteLinks.targetTitle })
    .from(noteLinks)
    .where(isNull(noteLinks.targetKey))
    .all()
  const keys = new Set<NameKey>()
  for (const row of rows) {
    const key = nameKey(row.targetTitle)
    if (key === null) continue
    keys.add(key)
    db.update(noteLinks)
      .set({ targetKey: key })
      .where(and(eq(noteLinks.sourceId, row.sourceId), eq(noteLinks.targetTitle, row.targetTitle)))
      .run()
  }
  return [...keys]
}
