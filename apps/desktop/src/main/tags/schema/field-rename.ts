/**
 * Vault-wide field rename (J1-2). A field name is a vault property key, so the
 * rename moves the property definition, every schema and saved tag view that
 * lists it, every note value and every task field value.
 *
 * Crash-safe: the job is recorded in data.db (`tags.fieldRenameJob`) before the
 * first step and cleared after the last, and vault open resumes a recorded job.
 * Every step only touches carriers of the old name, so a rerun finishes the
 * job without duplicating anything.
 */
import type { FieldRenameResult, TagsProgressEvent } from '@memry/contracts/tag-schema-api'
import type { ViewConfig } from '@memry/contracts/folder-view-api'
import { getNoteProperties } from '@main/database/queries/notes'
import { deleteSetting, getSetting, setSetting } from '@main/database/queries/settings'
import { listTagDefinitionRows, readTagViews } from '@main/database/queries/tag-definitions'
import { notesWithProperty, taskFieldValues } from '@main/database/queries/tag-schema-counts'
import { getIndexDatabase } from '../../database'
import type { DataDb } from '../../database/types'
import { createLogger } from '../../lib/logger'
import { generateId } from '../../lib/id'
import { setEntityProperties } from '../../notes/entity-properties'
import { createDesktopTasksDomain } from '../../tasks/domain'
import { createTasksPublisher } from '../../tasks/publisher'
import { isNoteLocked } from '../../vault-locks/registry'
import { PropertyDefinitionsService } from '../../vault/property-definitions'
import { parseSchemaColumn } from '../tag-schema'
import { tagKey } from '@memry/shared/tag-fold'
import { emitTagSchemasChanged, saveSchemaEdit } from './edit'
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

function renameInSchemasAndViews(db: DataDb, from: string, to: string): void {
  for (const row of listTagDefinitionRows(db)) {
    const key = tagKey(row.name)
    if (parseSchemaColumn(row.schema).kind === 'ok') {
      saveSchemaEdit(db, key, { kind: 'rename-field', from, to })
    }
    const views = readTagViews(db, row.name)
    const renamed = views ? renameInViews(views, from, to) : null
    if (renamed) saveTagViews(db, key, renamed)
  }
}

async function runJob(
  db: DataDb,
  job: FieldRenameJob,
  onProgress: (event: TagsProgressEvent) => void
): Promise<FieldRenameResult> {
  const { from, to, runId } = job
  await renameDefinition(from, to)
  renameInSchemasAndViews(db, from, to)
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
      const properties = getNoteProperties(indexDb, noteId)
      if (properties.some((p) => p.name === to)) {
        result.skippedExisting += 1
      } else {
        // Same order, so the key keeps its place in the frontmatter.
        const record: Record<string, unknown> = {}
        for (const p of properties) record[p.name === from ? to : p.name] = p.value
        const written = await setEntityProperties(noteId, record)
        if (written.success) result.notes += 1
        else log.warn('Could not rename a field on a note', { noteId, error: written.error })
      }
    }
    tick()
  }

  const tasksDomain = createDesktopTasksDomain(db, createTasksPublisher(), generateId)
  for (const task of taskCarriers) {
    if (to in task.fields) {
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

/** Renames field `from` to `to` everywhere. Re-running the same rename resumes it. */
export async function renameField(
  db: DataDb,
  job: FieldRenameJob,
  onProgress: (event: TagsProgressEvent) => void
): Promise<FieldRenameResult> {
  setSetting(db, FIELD_RENAME_JOB_SETTING, JSON.stringify(job))
  const result = await runJob(db, job, onProgress)
  deleteSetting(db, FIELD_RENAME_JOB_SETTING)
  return result
}

function readJob(db: DataDb): FieldRenameJob | null {
  const raw = getSetting(db, FIELD_RENAME_JOB_SETTING)
  if (raw === null) return null
  try {
    const job = JSON.parse(raw) as Partial<FieldRenameJob>
    if (typeof job.from === 'string' && typeof job.to === 'string') {
      return { from: job.from, to: job.to, runId: job.runId ?? 'resume' }
    }
  } catch {
    // Falls through to the warning below.
  }
  log.warn('Dropping an unreadable field rename job', { raw })
  deleteSetting(db, FIELD_RENAME_JOB_SETTING)
  return null
}

/** Vault open: finishes a rename an app quit or crash interrupted. */
export async function resumeFieldRename(
  db: DataDb,
  onProgress: (event: TagsProgressEvent) => void = () => {}
): Promise<FieldRenameResult | null> {
  const job = readJob(db)
  if (!job) return null
  log.info('Resuming an interrupted field rename', { from: job.from, to: job.to })
  return renameField(db, job, onProgress)
}
