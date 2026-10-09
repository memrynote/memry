/**
 * Vault-wide tag rename: `old` and every `old/…` child across notes (header
 * and body), journals, tasks, definitions and the schemas that reference them.
 *
 * Crash-safe: the job is recorded in data.db (`tags.renameJob`) before the
 * first step and cleared after the last, and vault open resumes a recorded
 * job. Every step only touches carriers of the old name, so a rerun finishes
 * the job without duplicating anything: a note's index rows move with its
 * file, so the index keeps naming the notes still to write.
 */
import { eq, like, or } from 'drizzle-orm'
import type { TagsProgressEvent } from '@memry/contracts/tag-schema-api'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import {
  isInlineTagName,
  rewriteInlineTagsInMarkdown,
  type TagRename
} from '@memry/shared/inline-tags'
import { foldTag, tagKey } from '@memry/shared/tag-fold'
import type { DataDb, IndexDb } from '../database/types'
import { renameTag, renameTagDefinition } from '@main/database/queries/notes'
import { deleteSetting, getSetting, setSetting } from '@main/database/queries/settings'
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

export const TAG_RENAME_JOB_SETTING = 'tags.renameJob'

export interface TagRenameJob {
  from: string
  to: string
  runId: string
}

export interface TagRenameResult {
  /** Notes whose file (or open doc) the rename wrote. */
  notesWritten: number
  /** Notes the rename could not write; their index rows already moved. */
  failedNoteIds: string[]
  /** The new name is not valid inline, so body `#tags` kept the old name. */
  bodySkipped: boolean
}

/** Another rename is recorded and unfinished. */
export class TagRenameInProgressError extends Error {
  constructor(readonly job: TagRenameJob) {
    super(`A rename of "${job.from}" to "${job.to}" is still running`)
  }
}

const PROGRESS_INTERVAL_MS = 100

const key = (tag: string): string => foldTag(tag.trim())

/**
 * The tag and each `/` child of it that any note, task or definition holds,
 * paired with its new name, children first: renaming `a` to `a/b` must move
 * the existing `a/b` to `a/b/b` before `a` lands on `a/b`.
 */
function renamePairs(indexDb: IndexDb, dataDb: DataDb, oldName: string, newName: string) {
  const oldKey = key(oldName)
  const oldDefinition = tagKey(oldName)
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
      .where(
        or(eq(tagDefinitions.name, oldDefinition), like(tagDefinitions.name, `${oldDefinition}/%`))
      )
      .all()
  ].map((row) => row.tag)
  const byKey = new Map<string, TagRename>([[oldKey, { from: oldKey, to: newTrim }]])
  for (const name of names) {
    // Carriers compare by identity (`foldTag`), definition names by their
    // full-lowercase key; each cuts its suffix at its own prefix length.
    const trimmed = name.trim()
    const isDefinitionChild = tagKey(trimmed).startsWith(`${oldDefinition}/`)
    const nameKey = key(trimmed)
    const isChild = nameKey.startsWith(`${oldKey}/`)
    // `like` treats `_` as a wildcard: keep real children.
    if (!isChild && !isDefinitionChild) continue
    const prefix = isChild ? oldKey.length : oldDefinition.length
    if (!byKey.has(nameKey)) {
      byKey.set(nameKey, { from: trimmed, to: newTrim + trimmed.slice(prefix) })
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
  const fromKey = tagKey(from)
  const toKey = tagKey(to)
  if (fromKey === toKey) return
  const find = (name: string) =>
    dataDb.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get()
  const snapshot = find(fromKey)
  if (!snapshot) return
  const merges = find(toKey) !== undefined
  renameTagDefinition(dataDb, fromKey, to)
  if (merges) syncMergedTagDefinitions(fromKey, toKey, snapshot)
  else syncTagDefinitionRename(fromKey, to, snapshot)
}

/**
 * One note's part of a rename: its header `tags:` list and, unless
 * `bodyRename` is empty, its body `#tags`. An open note's body is renamed
 * inside its live doc, and the write-back then writes the file; a closed note
 * is written through the note command, which feeds its stored doc. A
 * large-file-class body is never rewritten. Returns whether it wrote the note.
 */
async function renameInNote(
  indexDb: IndexDb,
  noteId: string,
  pairs: TagRename[],
  bodyRename: TagRename[]
): Promise<boolean> {
  if (!writableTagCarrier(indexDb, noteId)) return false
  const headerTags = { rename: pairs }
  const doc = getCrdtProvider().getDoc(noteId)
  if (doc) {
    await updateNoteCommand({ id: noteId, headerTags })
    if (renameTagsInDoc(doc, bodyRename)) scheduleWriteback(noteId, doc, 'local')
    return true
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
  return true
}

function notesHolding(indexDb: IndexDb, oldKey: string): string[] {
  return indexDb
    .selectDistinct({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(or(eq(noteTags.tag, oldKey), like(noteTags.tag, `${oldKey}/%`)))
    .all()
    .map((row) => row.noteId)
}

async function runJob(
  indexDb: IndexDb,
  dataDb: DataDb,
  { from: oldName, to: newName, runId }: TagRenameJob,
  onProgress: (event: TagsProgressEvent) => void
): Promise<TagRenameResult> {
  const pairs = renamePairs(indexDb, dataDb, oldName, newName)
  const oldKey = key(oldName)
  const noteIds = notesHolding(indexDb, oldKey)

  // Definitions first: a note write creates a missing definition, which the
  // move would then merge into and lose the old one's look and schema.
  for (const pair of pairs) rewriteSchemaReferences(dataDb, pair.from, pair.to)
  for (const pair of pairs) moveDefinition(dataDb, pair)
  commitTaskRetag(dataDb, () => {
    const taskIds = new Set<string>()
    for (const pair of pairs) {
      for (const id of mergeTagInTasks(dataDb, pair.from, pair.to).taskIds) taskIds.add(id)
    }
    return { taskIds: [...taskIds] }
  })

  // A name the inline grammar cannot read back (`my project`, `2024`) would
  // turn `#old` into broken text: the header and definition still rename.
  const bodySkipped = !isInlineTagName(newName.trim())
  const bodyRename = bodySkipped ? [] : [{ from: oldKey, to: newName.trim() }]
  const result: TagRenameResult = { notesWritten: 0, failedNoteIds: [], bodySkipped }
  let lastEmit = 0
  for (const [index, noteId] of noteIds.entries()) {
    try {
      if (await renameInNote(indexDb, noteId, pairs, bodyRename)) result.notesWritten += 1
    } catch (err) {
      result.failedNoteIds.push(noteId)
      log.warn('Failed to rename the tag in a note', { noteId, err })
      trackMainError('tags', 'frontmatter_writeback', err)
    }
    const now = Date.now()
    if (index === noteIds.length - 1 || now - lastEmit >= PROGRESS_INTERVAL_MS) {
      lastEmit = now
      onProgress({ runId, done: index + 1, total: noteIds.length })
    }
  }
  if (noteIds.length === 0) onProgress({ runId, done: 0, total: 0 })

  const caseOnly = oldKey === key(newName)
  const restoreLockedTags = keepLockedNoteTags(indexDb, oldName)
  if (caseOnly) renameTag(indexDb, oldName, newName)
  else for (const pair of pairs) mergeTagInNotes(indexDb, pair.from, pair.to)
  restoreLockedTags()

  return result
}

function readJob(dataDb: DataDb): TagRenameJob | null {
  const raw = getSetting(dataDb, TAG_RENAME_JOB_SETTING)
  if (raw === null) return null
  try {
    const job = JSON.parse(raw) as Partial<TagRenameJob>
    if (typeof job.from === 'string' && typeof job.to === 'string') {
      return { from: job.from, to: job.to, runId: job.runId ?? 'resume' }
    }
  } catch {
    // Falls through to the warning below.
  }
  log.warn('Dropping an unreadable tag rename job', { raw })
  deleteSetting(dataDb, TAG_RENAME_JOB_SETTING)
  return null
}

/**
 * Renames `job.from` and every `/` child of it everywhere. A new name that
 * already exists merges into it. Re-running the recorded job resumes it; any
 * other rename while one is recorded throws `TagRenameInProgressError`.
 */
export async function renameTagEverywhere(
  indexDb: IndexDb,
  dataDb: DataDb,
  job: TagRenameJob,
  onProgress: (event: TagsProgressEvent) => void = () => {}
): Promise<TagRenameResult> {
  const recorded = readJob(dataDb)
  if (recorded && (recorded.from !== job.from || recorded.to !== job.to)) {
    throw new TagRenameInProgressError(recorded)
  }
  setSetting(dataDb, TAG_RENAME_JOB_SETTING, JSON.stringify(job))
  const result = await runJob(indexDb, dataDb, job, onProgress)
  deleteSetting(dataDb, TAG_RENAME_JOB_SETTING)
  return result
}

/** Vault open: finishes a tag rename an app quit or crash interrupted. */
export async function resumeTagRename(
  indexDb: IndexDb,
  dataDb: DataDb
): Promise<TagRenameResult | null> {
  const job = readJob(dataDb)
  if (!job) return null
  log.info('Resuming an interrupted tag rename', { from: job.from, to: job.to })
  return renameTagEverywhere(indexDb, dataDb, job)
}
