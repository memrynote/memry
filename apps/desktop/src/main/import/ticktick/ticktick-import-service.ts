/**
 * TickTick CSV import service (main process I/O wiring).
 *
 * Parses a TickTick backup CSV, maps it to an ImportPlan via the pure
 * `@memry/ticktick-import` package, then applies it through the async tasks
 * domain layer + reminders lib (see `apply-plan.ts` for the orchestration).
 *
 * @module main/import/ticktick/ticktick-import-service
 */

import type { DataDb } from '../../database'
import { getInboxProject, getStatusesByProject } from '@main/database/queries/projects'
import { createDesktopTasksDomain } from '../../tasks/domain'
import { createTasksPublisher } from '../../tasks/publisher'
import { generateId } from '../../lib/id'
import * as remindersService from '../../lib/reminders'
import { createLogger } from '../../lib/logger'
import { parseTickTickCsv, mapRows } from '@memry/ticktick-import'
import type { TickTickImportSummary } from '@memry/contracts/ticktick-import-api'
import { applyPlan, type ApplyDeps } from './apply-plan'

const log = createLogger('TickTickImport')

/** Build the real (db-backed) deps for the apply orchestration. */
export function createApplyDeps(db: DataDb): ApplyDeps {
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

/** Parse + map + apply a TickTick CSV file's contents into the data DB. */
export async function importTickTickCsv(
  db: DataDb,
  csvText: string
): Promise<TickTickImportSummary> {
  const rows = parseTickTickCsv(csvText)
  const plan = mapRows(rows, { now: new Date().toISOString() })
  log.info(`Importing ${plan.stats.tasks} tasks across ${plan.stats.projects} projects`)
  return applyPlan(plan, createApplyDeps(db))
}
