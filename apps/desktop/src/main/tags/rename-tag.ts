import type { TagsProgressEvent } from '@memry/contracts/tag-schema-api'
import { noteTags } from '@memry/db-schema/schema/notes-cache'
import { taskTags } from '@memry/db-schema/schema/task-relations'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import {
  isInlineTagName,
  rewriteInlineTagsInMarkdown,
  type TagRename
} from '@memry/shared/inline-tags'
import { suffixBelow, tagKey } from '@memry/shared/tag-fold'
import type { DataDb, IndexDb } from '../database/types'
import { renameTag, renameTagDefinition } from '@main/database/queries/notes'
import { deleteSetting, getSetting, setSetting } from '@main/database/queries/settings'
import { mergeTagInNotes, mergeTagInTasks } from '@main/database/queries/tags'
import { tagIs, tagOrUnder, tagUnder } from '@main/database/queries/tag-match'
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
  notesWritten: number
  failedNoteIds: string[]
  bodySkipped: boolean
}

export class TagRenameInProgressError extends Error {
  constructor(readonly job: TagRenameJob) {
    super(`A rename of "${job.from}" to "${job.to}" is still running`)
  }
}

const PROGRESS_INTERVAL_MS = 100

function renamePairs(indexDb: IndexDb, dataDb: DataDb, oldName: string, newName: string) {
  const oldKey = tagKey(oldName)
  const oldTrim = oldName.trim()
  const newTrim = newName.trim()
  const names = [
    ...indexDb
      .selectDistinct({ tag: noteTags.tag })
      .from(noteTags)
      .where(tagUnder(noteTags.tag, oldTrim))
      .all(),
    ...dataDb
      .selectDistinct({ tag: taskTags.tag })
      .from(taskTags)
      .where(tagUnder(taskTags.tag, oldTrim))
      .all(),
    ...dataDb
      .select({ tag: tagDefinitions.name })
      .from(tagDefinitions)
      .where(tagUnder(tagDefinitions.name, oldTrim))
      .all()
  ].map((row) => row.tag)
  const byKey = new Map<string, TagRename>([[oldKey, { from: oldKey, to: newTrim }]])
  for (const name of names) {
    const trimmed = name.trim()
    const nameKey = tagKey(trimmed)
    if (!byKey.has(nameKey)) {
      byKey.set(nameKey, { from: trimmed, to: newTrim + suffixBelow(trimmed, oldTrim) })
    }
  }
  return [...byKey.values()].sort((a, b) => b.from.split('/').length - a.from.split('/').length)
}

function moveDefinition(dataDb: DataDb, { from, to }: TagRename): void {
  const fromKey = tagKey(from)
  const toKey = tagKey(to)
  if (fromKey === toKey) return
  const find = (name: string) =>
    dataDb.select().from(tagDefinitions).where(tagIs(tagDefinitions.name, name)).get()
  const snapshot = find(fromKey)
  if (!snapshot) return
  const merges = find(toKey) !== undefined
  renameTagDefinition(dataDb, fromKey, to)
  if (merges) syncMergedTagDefinitions(toKey, snapshot)
  else syncTagDefinitionRename(to, snapshot)
}

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

function notesHolding(indexDb: IndexDb, oldName: string): string[] {
  return indexDb
    .selectDistinct({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(tagOrUnder(noteTags.tag, oldName))
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
  const oldKey = tagKey(oldName)
  const noteIds = notesHolding(indexDb, oldName)

  for (const pair of pairs) rewriteSchemaReferences(dataDb, pair.from, pair.to)
  for (const pair of pairs) moveDefinition(dataDb, pair)
  commitTaskRetag(dataDb, () => {
    const taskIds = new Set<string>()
    for (const pair of pairs) {
      for (const id of mergeTagInTasks(dataDb, pair.from, pair.to).taskIds) taskIds.add(id)
    }
    return { taskIds: [...taskIds] }
  })

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

  const caseOnly = oldKey === tagKey(newName)
  const restoreLockedTags = keepLockedNoteTags(indexDb, oldName)
  if (caseOnly) renameTag(indexDb, oldName, newName)
  else for (const pair of pairs) mergeTagInNotes(indexDb, pair.from, pair.to)
  restoreLockedTags()

  return result
}

function readJob(dataDb: DataDb): TagRenameJob | null {
  const raw = getSetting(dataDb, TAG_RENAME_JOB_SETTING)
  if (raw === null) return null
  let job: Partial<TagRenameJob> = {}
  try {
    job = JSON.parse(raw) as Partial<TagRenameJob>
  } catch (err) {
    log.warn('Rename job setting is not JSON', { err })
  }
  if (typeof job?.from === 'string' && typeof job.to === 'string') {
    return { from: job.from, to: job.to, runId: job.runId ?? 'resume' }
  }
  log.warn('Dropping an unreadable tag rename job', { raw })
  deleteSetting(dataDb, TAG_RENAME_JOB_SETTING)
  return null
}

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

export async function resumeTagRename(
  indexDb: IndexDb,
  dataDb: DataDb
): Promise<TagRenameResult | null> {
  const job = readJob(dataDb)
  if (!job) return null
  log.info('Resuming an interrupted tag rename', { from: job.from, to: job.to })
  return renameTagEverywhere(indexDb, dataDb, job)
}
