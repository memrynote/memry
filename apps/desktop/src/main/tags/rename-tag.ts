import { eq, like, or } from 'drizzle-orm'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { rewriteInlineTagsInMarkdown, type TagRename } from '@memry/shared/inline-tags'
import type { DataDb, IndexDb } from '../database/types'
import { renameTag, renameTagDefinition } from '@main/database/queries/notes'
import { mergeTagInNotes, mergeTagInTasks } from '@main/database/queries/tags'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { updateNoteCommand } from '../notes/domain'
import { getNoteById } from '../vault/notes'
import { getCrdtProvider } from '../sync/crdt-provider'
import { scheduleWriteback } from '../sync/crdt-writeback'
import { keepLockedNoteTags, writableTagCarrier } from './note-tag-edits'
import { renameTagsInDoc } from './rename-tag-in-doc'
import { rewriteSchemaReferences } from './schema/references'
import {
  commitTaskRetag,
  syncMergedTagDefinitions,
  syncTagDefinitionRename
} from './runtime-effects'

const log = createLogger('RenameTag')

const key = (tag: string): string => tag.trim().toLowerCase()

/**
 * The tag and each `/` child of it that any note, task or definition holds,
 * paired with its new name, children first: renaming `a` to `a/b` must move
 * the existing `a/b` to `a/b/b` before `a` lands on `a/b`.
 */
function renamePairs(indexDb: IndexDb, dataDb: DataDb, oldName: string, newName: string) {
  const oldKey = key(oldName)
  const newTrim = newName.trim()
  const names = [
    ...indexDb
      .selectDistinct({ tag: noteTags.tag })
      .from(noteTags)
      .where(or(eq(noteTags.tag, oldKey), like(noteTags.tag, `${oldKey}/%`)))
      .all(),
    ...dataDb
      .selectDistinct({ tag: taskTags.tag })
      .from(taskTags)
      .where(or(eq(taskTags.tag, oldKey), like(taskTags.tag, `${oldKey}/%`)))
      .all(),
    ...dataDb
      .select({ tag: tagDefinitions.name })
      .from(tagDefinitions)
      .where(or(eq(tagDefinitions.name, oldKey), like(tagDefinitions.name, `${oldKey}/%`)))
      .all()
  ].map((row) => row.tag)
  const byKey = new Map<string, TagRename>([[oldKey, { from: oldKey, to: newTrim }]])
  for (const name of names) {
    const nameKey = key(name)
    // `like` folds only ASCII and treats `_` as a wildcard: keep real children.
    if (nameKey !== oldKey && !nameKey.startsWith(`${oldKey}/`)) continue
    if (!byKey.has(nameKey)) {
      byKey.set(nameKey, { from: nameKey, to: newTrim + name.trim().slice(oldKey.length) })
    }
  }
  return [...byKey.values()].sort((a, b) => b.from.split('/').length - a.from.split('/').length)
}

/**
 * Moves one definition: onto a free name it keeps its color, icon, views and
 * schema; onto a name that already has a definition it merges, so the target
 * keeps its own (as `tags:merge` does).
 */
function moveDefinition(dataDb: DataDb, { from, to }: TagRename): void {
  const toKey = key(to)
  if (from === toKey) return
  const find = (name: string) =>
    dataDb.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()
  const snapshot = find(from)
  if (!snapshot) return
  const merges = find(toKey) !== undefined
  renameTagDefinition(dataDb, from, to)
  if (merges) syncMergedTagDefinitions(from, toKey, snapshot)
  else syncTagDefinitionRename(from, to, snapshot)
}

/**
 * One note's part of a rename: its header `tags:` list and its body `#tags`.
 * An open note's body is renamed inside its live doc, and the write-back then
 * writes the file; a closed note is written through the note command, which
 * feeds its stored doc. A large-file-class body is never rewritten.
 */
async function renameInNote(
  indexDb: IndexDb,
  noteId: string,
  pairs: TagRename[],
  bodyRename: TagRename[]
): Promise<void> {
  if (!writableTagCarrier(indexDb, noteId)) return
  const headerTags = { rename: pairs }
  const doc = getCrdtProvider().getDoc(noteId)
  if (doc) {
    await updateNoteCommand({ id: noteId, headerTags })
    if (renameTagsInDoc(doc, bodyRename)) scheduleWriteback(noteId, doc, 'local')
    return
  }
  const note = await getNoteById(noteId)
  const content =
    note && note.sizeClass !== 'large-file'
      ? rewriteInlineTagsInMarkdown(note.content, bodyRename)
      : undefined
  await updateNoteCommand({
    id: noteId,
    headerTags,
    ...(content !== undefined && content !== note?.content ? { content } : {})
  })
}

/**
 * Renames `oldName` and every `/` child of it across notes (header and body),
 * journals, tasks, definitions and the schemas that reference them. A new name
 * that already exists merges into it. Returns the number of notes touched.
 */
export async function renameTagEverywhere(
  indexDb: IndexDb,
  dataDb: DataDb,
  oldName: string,
  newName: string
): Promise<number> {
  const pairs = renamePairs(indexDb, dataDb, oldName, newName)
  const oldKey = key(oldName)
  const noteIds = indexDb
    .selectDistinct({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(or(eq(noteTags.tag, oldKey), like(noteTags.tag, `${oldKey}/%`)))
    .all()
    .map((row) => row.noteId)

  const caseOnly = oldKey === key(newName)
  const restoreLockedTags = keepLockedNoteTags(indexDb, oldName)
  if (caseOnly) renameTag(indexDb, oldName, newName)
  else for (const pair of pairs) mergeTagInNotes(indexDb, pair.from, pair.to)
  restoreLockedTags()

  // Before the note writes below, which an app quit can interrupt.
  commitTaskRetag(dataDb, () => {
    const taskIds = new Set<string>()
    for (const pair of pairs) {
      for (const id of mergeTagInTasks(dataDb, pair.from, pair.to).taskIds) taskIds.add(id)
    }
    return { taskIds: [...taskIds] }
  })

  for (const pair of pairs) moveDefinition(dataDb, pair)
  for (const pair of pairs) rewriteSchemaReferences(dataDb, pair.from, pair.to)

  const bodyRename = [{ from: oldKey, to: newName.trim() }]
  await Promise.all(
    noteIds.map((noteId) =>
      renameInNote(indexDb, noteId, pairs, bodyRename).catch((err) => {
        log.warn('Failed to rename the tag in a note', { noteId, err })
        // DB and vault file now diverge; must reach Error Tracking.
        trackMainError('tags', 'frontmatter_writeback', err)
      })
    )
  )
  return noteIds.length
}
