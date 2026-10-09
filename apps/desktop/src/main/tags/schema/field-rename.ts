import type { FieldRenameResult, TagsProgressEvent } from '@memry/contracts/tag-schema-api'
import type { ViewConfig } from '@memry/contracts/folder-view-api'
import { deleteSetting, getSetting, setSetting } from '@main/database/queries/settings'
import { listTagDefinitionRows, readTagViews } from '@main/database/queries/tag-definitions'
import { notesWithProperty, taskFieldValues } from '@main/database/queries/tag-schema-counts'
import { getIndexDatabase } from '../../database'
import type { DataDb } from '../../database/types'
import { createLogger } from '../../lib/logger'
import { generateId } from '../../lib/id'
import { mergeEntityProperties } from '../../notes/entity-properties'
import { getMainI18n } from '../../lib/main-i18n'
import { getNoteById } from '../../vault/notes'
import { extractProperties } from '../../vault/frontmatter'
import { createDesktopTasksDomain } from '../../tasks/domain'
import { createTasksPublisher } from '../../tasks/publisher'
import { isNoteLocked } from '../../vault-locks/registry'
import { PropertyDefinitionsService } from '../../vault/property-definitions'
import { parseSchemaColumn } from '../tag-schema'
import { tagKey } from '@memry/shared/tag-fold'
import { emitTagSchemasChanged, planSchemaEdit, saveSchemaEdit } from './edit'
import { saveTagViews } from './views'

const log = createLogger('FieldRename')

export const FIELD_RENAME_JOB_SETTING = 'tags.fieldRenameJob'

interface FieldRenameJob {
  from: string
  to: string
  runId: string
}

const PROGRESS_INTERVAL_MS = 100

async function renameDefinition(from: string, to: string): Promise<void> {
  const service = PropertyDefinitionsService.tryGet()
  const definition = service?.get(from)
  if (!service || !definition) return
  if (!service.get(to)) await service.upsert({ ...definition, name: to })
  await service.remove(from)
}

function renameInViews(views: ViewConfig[], from: string, to: string): ViewConfig[] | null {
  let changed = false
  const swap = (name: string): string => {
    if (name !== from) return name
    changed = true
    return to
  }
  const next = views.map((view) => ({
    ...view,
    ...(view.columns ? { columns: view.columns.map((c) => ({ ...c, id: swap(c.id) })) } : {}),
    ...(view.order ? { order: view.order.map((o) => ({ ...o, property: swap(o.property) })) } : {}),
    ...(view.groupBy ? { groupBy: { ...view.groupBy, property: swap(view.groupBy.property) } } : {})
  }))
  return changed ? next : null
}

function schemaKeys(db: DataDb): string[] {
  return listTagDefinitionRows(db)
    .filter((row) => parseSchemaColumn(row.schema).kind === 'ok')
    .map((row) => tagKey(row.name))
}

function renameInSchemasAndViews(db: DataDb, job: FieldRenameJob, resuming: boolean): void {
  const { from, to } = job
  for (const key of schemaKeys(db)) {
    saveSchemaEdit(db, key, { kind: 'rename-field', from, to, resuming })
  }
  for (const row of listTagDefinitionRows(db)) {
    const key = tagKey(row.name)
    const views = readTagViews(db, row.name)
    const renamed = views ? renameInViews(views, from, to) : null
    if (renamed) saveTagViews(db, key, renamed)
  }
}

const fold = (name: string): string => name.toLowerCase()

function holdsTarget(keys: Iterable<string>, from: string, to: string): boolean {
  for (const key of keys) if (key !== from && fold(key) === fold(to)) return true
  return false
}

async function runJob(
  db: DataDb,
  job: FieldRenameJob,
  resuming: boolean,
  onProgress: (event: TagsProgressEvent) => void
): Promise<FieldRenameResult> {
  const { from, to, runId } = job
  await renameDefinition(from, to)
  renameInSchemasAndViews(db, job, resuming)
  emitTagSchemasChanged()

  const indexDb = getIndexDatabase()
  const noteIds = notesWithProperty(indexDb, from)
  const taskCarriers = taskFieldValues(db).filter((task) => from in task.fields)
  const total = noteIds.length + taskCarriers.length
  const result: FieldRenameResult = { notes: 0, tasks: 0, skippedLocked: 0, skippedExisting: 0 }
  let done = 0
  let lastEmit = 0
  const tick = (): void => {
    done += 1
    const now = Date.now()
    if (done === total || now - lastEmit >= PROGRESS_INTERVAL_MS) {
      lastEmit = now
      onProgress({ runId, done, total })
    }
  }

  for (const noteId of noteIds) {
    if (isNoteLocked(noteId)) {
      result.skippedLocked += 1
    } else {
      const note = await getNoteById(noteId)
      const properties = note ? extractProperties(note.frontmatter) : {}
      if (holdsTarget(Object.keys(properties), from, to)) {
        result.skippedExisting += 1
      } else if (Object.hasOwn(properties, from)) {
        const written = await mergeEntityProperties(noteId, {
          [from]: null,
          [to]: properties[from]
        })
        if (written.success) result.notes += 1
        else log.warn('Could not rename a field on a note', { noteId, error: written.error })
      }
    }
    tick()
  }

  const tasksDomain = createDesktopTasksDomain(db, createTasksPublisher(), generateId)
  for (const task of taskCarriers) {
    if (holdsTarget(Object.keys(task.fields), from, to)) {
      result.skippedExisting += 1
    } else {
      await tasksDomain.updateTask({
        id: task.id,
        fields: { [from]: null, [to]: task.fields[from] }
      })
      result.tasks += 1
    }
    tick()
  }
  if (total === 0) onProgress({ runId, done: 0, total: 0 })
  return result
}

let running: Promise<FieldRenameResult> | null = null

export async function renameField(
  db: DataDb,
  job: FieldRenameJob,
  onProgress: (event: TagsProgressEvent) => void
): Promise<FieldRenameResult> {
  const recorded = readJob(db)
  const resuming = recorded?.from === job.from && recorded.to === job.to
  if ((recorded && !resuming) || running) {
    const busy = recorded ?? job
    throw new Error(
      getMainI18n().t('errors:tagFields.renameRunning', { from: busy.from, to: busy.to })
    )
  }
  if (!resuming) {
    for (const key of schemaKeys(db)) {
      planSchemaEdit(db, key, { kind: 'rename-field', from: job.from, to: job.to })
    }
  }
  setSetting(db, FIELD_RENAME_JOB_SETTING, JSON.stringify(job))
  running = runJob(db, job, resuming, onProgress)
  try {
    const result = await running
    if (result.skippedLocked === 0) deleteSetting(db, FIELD_RENAME_JOB_SETTING)
    return result
  } finally {
    running = null
  }
}

function readJob(db: DataDb): FieldRenameJob | null {
  const raw = getSetting(db, FIELD_RENAME_JOB_SETTING)
  if (raw === null) return null
  let job: Partial<FieldRenameJob> = {}
  try {
    job = JSON.parse(raw) as Partial<FieldRenameJob>
  } catch (err) {
    log.warn('Rename job setting is not JSON', { err })
  }
  if (typeof job?.from === 'string' && typeof job.to === 'string') {
    return { from: job.from, to: job.to, runId: job.runId ?? 'resume' }
  }
  log.warn('Dropping an unreadable field rename job', { raw })
  deleteSetting(db, FIELD_RENAME_JOB_SETTING)
  return null
}

export async function resumeFieldRename(
  db: DataDb,
  onProgress: (event: TagsProgressEvent) => void = () => {}
): Promise<FieldRenameResult | null> {
  const job = readJob(db)
  if (!job || running) return null
  log.info('Resuming a recorded field rename', { from: job.from, to: job.to })
  return renameField(db, job, onProgress)
}
