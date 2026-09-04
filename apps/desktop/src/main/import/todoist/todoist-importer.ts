/**
 * Todoist CSV importer (framework-native).
 *
 * Reuses the pure `@memry/importers/todoist` package, applies plans through the
 * tasks domain, and plugs into the generic import framework (registry + preview
 * + streaming progress).
 *
 * @module main/import/todoist/todoist-importer
 */

import { readFile } from 'fs/promises'
import { basename } from 'path'
import { parseTodoistCsv, mapRows, type ImportPlan } from '@memry/importers/todoist'
import { IMPORT_MESSAGE_CODES, IMPORT_STATUS, toImportMessage } from '@memry/importers/messages'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportPreview } from '../types'

const logger = createLogger('TodoistImport')

/** The minimal slice of the tasks domain the importer needs (keeps it testable). */
export interface ImportTasksDomain {
  createProject(input: { name: string }): Promise<{ project: { id: string } }>
  createTask(input: {
    projectId: string
    parentId: string | null
    title: string
    description: string | null
    priority: number
    dueDate: string | null
    dueTime: string | null
    position: number
  }): Promise<{ task: { id: string } | null; error?: string }>
}

/** Build the real desktop tasks domain (lazy so importing this module stays light). */
async function defaultDomain(): Promise<ImportTasksDomain> {
  const { requireDatabase } = await import('../../database')
  const { createDesktopTasksDomain } = await import('../../tasks/domain')
  const { createTasksPublisher } = await import('../../tasks/publisher')
  const { generateId } = await import('../../lib/id')
  return createDesktopTasksDomain(requireDatabase(), createTasksPublisher(), generateId)
}

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : fallback

function projectNameFromPath(p: string): string {
  return (
    basename(p)
      .replace(/\.csv$/i, '')
      .trim() || 'Imported Todoist Project'
  )
}

async function planForFile(filePath: string, now: Date): Promise<ImportPlan> {
  const raw = await readFile(filePath, 'utf-8')
  return mapRows(parseTodoistCsv(raw), projectNameFromPath(filePath), { now })
}

/** Parse each file into preview groups — performs no writes. */
export async function buildTodoistPreview(
  filePaths: string[],
  now: Date,
  signal?: AbortSignal
): Promise<ImportPreview> {
  const groups: ImportPreview['groups'] = []
  for (const fp of filePaths) {
    if (signal?.aborted) break
    try {
      const plan = await planForFile(fp, now)
      groups.push({
        label: plan.project.name || basename(fp),
        counts: [
          { labelKey: 'import.stats.tasks', value: plan.stats.tasks },
          { labelKey: 'import.stats.subtasks', value: plan.stats.subtasks },
          { labelKey: 'import.stats.withDueDate', value: plan.stats.withDueDate },
          { labelKey: 'import.stats.comments', value: plan.stats.comments },
          { labelKey: 'import.stats.skipped', value: plan.stats.skipped }
        ],
        sampleTitles: plan.sampleTitles,
        warnings: plan.warnings
      })
    } catch (err) {
      groups.push({
        label: basename(fp),
        counts: [],
        error: toImportMessage(err, {
          code: IMPORT_MESSAGE_CODES.readFileFailed,
          message: 'Failed to read file'
        })
      })
    }
  }
  return { groups }
}

/**
 * Apply each file's plan: create a project, then its tasks (parents before
 * children), streaming progress through `ctx`. A failing file is isolated.
 */
export async function applyTodoistImport(
  filePaths: string[],
  domain: ImportTasksDomain,
  ctx: ImportContext,
  now: Date
): Promise<void> {
  const parsed: { fileName: string; plan?: ImportPlan; error?: string }[] = []
  for (const fp of filePaths) {
    try {
      parsed.push({ fileName: basename(fp), plan: await planForFile(fp, now) })
    } catch (err) {
      parsed.push({ fileName: basename(fp), error: errorMessage(err, 'Import failed') })
    }
  }

  const total = parsed.reduce((n, p) => n + (p.plan?.tasks.length ?? 0), 0)
  let done = 0
  ctx.reportProgress(0, total)

  for (const entry of parsed) {
    if (ctx.isCancelled()) return
    if (!entry.plan) {
      logger.error('Todoist import failed for file', entry.fileName, entry.error)
      ctx.reportFailed(entry.fileName, entry.error)
      continue
    }
    try {
      const { project } = await domain.createProject({ name: entry.plan.project.name })
      const idMap = new Map<string, string>()
      for (const tk of entry.plan.tasks) {
        if (ctx.isCancelled()) return
        const parentId = tk.parentTempId ? (idMap.get(tk.parentTempId) ?? null) : null
        const { task, error } = await domain.createTask({
          projectId: project.id,
          parentId,
          title: tk.title,
          description: tk.description,
          priority: tk.priority,
          dueDate: tk.dueDate,
          dueTime: tk.dueTime,
          position: tk.position
        })
        // The project was created two lines up, so this is unreachable in
        // practice; the file is still reported as failed rather than importing
        // a silently truncated task list.
        if (!task) throw new Error(error ?? 'Task creation failed')
        idMap.set(tk.tempId, task.id)
        done++
        ctx.reportImported()
        ctx.reportProgress(done, total)
      }
    } catch (err) {
      logger.error('Todoist import failed for file', entry.fileName, err)
      ctx.reportFailed(entry.fileName, err)
    }
  }
}

export const todoistImporter: Importer = {
  id: 'todoist',
  name: 'Todoist',
  descriptionKey: 'import.sources.todoist',
  fileSpec: { label: 'Todoist CSV export', extensions: ['csv'], allowMultiple: true },
  preview: (input, signal) => buildTodoistPreview(input.sourcePaths, new Date(), signal),
  run: async (input, ctx) => {
    ctx.setPhase('importing')
    ctx.status(IMPORT_STATUS.todoistImporting)
    const domain = await defaultDomain()
    await applyTodoistImport(input.sourcePaths, domain, ctx, new Date())
    return ctx.toSummary()
  }
}
