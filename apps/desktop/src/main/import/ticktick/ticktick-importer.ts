/**
 * TickTick CSV importer (framework-native).
 *
 * Reuses the pure `@memry/importers/ticktick` package to parse a TickTick backup
 * CSV into an ImportPlan, then applies it through the tasks domain + reminders
 * lib (see `apply-plan.ts`). Plugs into the generic import framework (registry +
 * preview + streaming progress).
 *
 * @module main/import/ticktick/ticktick-importer
 */

import { readFile } from 'fs/promises'
import { basename } from 'path'
import { parseTickTickCsv, mapRows, type ImportPlan } from '@memry/importers/ticktick'
import { IMPORT_MESSAGE_CODES, toImportMessage } from '@memry/importers/messages'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportPreview } from '../types'
import { applyPlan, type ApplyDeps } from './apply-plan'

const logger = createLogger('TickTickImport')

/** Build the real (db-backed) apply deps lazily so importing this module stays light. */
async function defaultDeps(): Promise<ApplyDeps> {
  const { requireDatabase } = await import('../../database')
  const { createDesktopTasksDomain } = await import('../../tasks/domain')
  const { createTasksPublisher } = await import('../../tasks/publisher')
  const { generateId } = await import('../../lib/id')
  const { getInboxProject, getStatusesByProject } = await import('@main/database/queries/projects')
  const remindersService = await import('../../lib/reminders')

  const db = requireDatabase()
  const domain = createDesktopTasksDomain(db, createTasksPublisher(), generateId)
  return {
    createProject: (a) => domain.createProject(a),
    createTask: (a) => domain.createTask(a),
    completeTask: (a) => domain.completeTask(a),
    archiveTask: (id) => domain.archiveTask(id),
    getInboxProjectId: () => getInboxProject(db)?.id,
    getStatusesByProject: (pid) => getStatusesByProject(db, pid),
    createReminder: (a) => {
      remindersService.createReminder(a)
    }
  }
}

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : fallback

async function planForFile(filePath: string, now: string): Promise<ImportPlan> {
  const raw = await readFile(filePath, 'utf-8')
  return mapRows(parseTickTickCsv(raw), { now })
}

/** Parse each file into preview groups — performs no writes. */
export async function buildTickTickPreview(
  filePaths: string[],
  now: string,
  signal?: AbortSignal
): Promise<ImportPreview> {
  const groups: ImportPreview['groups'] = []
  for (const fp of filePaths) {
    if (signal?.aborted) break
    try {
      const plan = await planForFile(fp, now)
      groups.push({
        label: basename(fp),
        counts: [
          { labelKey: 'import.stats.projects', value: plan.stats.projects },
          { labelKey: 'import.stats.tasks', value: plan.stats.tasks },
          { labelKey: 'import.stats.subtasks', value: plan.stats.subtasks },
          { labelKey: 'import.stats.reminders', value: plan.stats.reminders }
        ],
        sampleTitles: plan.tasks.slice(0, 5).map((t) => t.title),
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
 * Parse + apply each file's plan, streaming progress through `ctx`. A failing
 * file is isolated; per-row failures are reported but never abort the run.
 */
export async function runTickTickImport(
  filePaths: string[],
  deps: ApplyDeps,
  ctx: ImportContext,
  now: string
): Promise<void> {
  const parsed: { fileName: string; plan?: ImportPlan; error?: string }[] = []
  for (const fp of filePaths) {
    try {
      parsed.push({ fileName: basename(fp), plan: await planForFile(fp, now) })
    } catch (err) {
      parsed.push({ fileName: basename(fp), error: errorMessage(err, 'Import failed') })
    }
  }

  const total = parsed.reduce((n, p) => n + (p.plan?.stats.tasks ?? 0), 0)
  let done = 0
  ctx.reportProgress(0, total)

  for (const entry of parsed) {
    if (ctx.isCancelled()) return
    if (!entry.plan) {
      logger.error('TickTick import failed for file', entry.fileName, entry.error)
      ctx.reportFailed(entry.fileName, entry.error)
      continue
    }
    await applyPlan(entry.plan, deps, ctx)
    done += entry.plan.stats.tasks
    ctx.reportProgress(done, total)
  }
}

export const ticktickImporter: Importer = {
  id: 'ticktick',
  name: 'TickTick',
  descriptionKey: 'import.sources.ticktick',
  fileSpec: { label: 'TickTick CSV backup', extensions: ['csv'], allowMultiple: true },
  preview: (input, signal) =>
    buildTickTickPreview(input.sourcePaths, new Date().toISOString(), signal),
  run: async (input, ctx) => {
    ctx.setPhase('importing')
    ctx.status('Importing TickTick tasks…')
    const deps = await defaultDeps()
    await runTickTickImport(input.sourcePaths, deps, ctx, new Date().toISOString())
    return ctx.toSummary()
  }
}
