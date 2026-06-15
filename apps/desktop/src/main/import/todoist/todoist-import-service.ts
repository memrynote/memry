/**
 * Todoist CSV import service (main process).
 *
 * Reads .csv files, transforms them through the pure `@memry/todoist-import`
 * package, and applies the resulting plan sequentially through the tasks domain.
 *
 * @module main/import/todoist/todoist-import-service
 */

import { readFile } from 'fs/promises'
import { basename } from 'path'
import { parseTodoistCsv, mapRows, type ImportPlan, type ImportStats } from '@memry/todoist-import'
import { createLogger } from '../../lib/logger'

const logger = createLogger('TodoistImport')

/** Build the real desktop tasks domain (lazy so importing this module stays light). */
async function defaultDomain(): Promise<ImportTasksDomain> {
  const { requireDatabase } = await import('../../database')
  const { createDesktopTasksDomain } = await import('../../tasks/domain')
  const { createTasksPublisher } = await import('../../tasks/publisher')
  const { generateId } = await import('../../lib/id')
  return createDesktopTasksDomain(requireDatabase(), createTasksPublisher(), generateId)
}

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
  }): Promise<{ task: { id: string } }>
}

export interface PreviewFile {
  fileName: string
  projectName: string
  stats: ImportStats
  sampleTitles: string[]
  warnings: string[]
  error?: string
}

export interface ImportFileResult {
  projectName: string
  projectId: string | null
  stats: ImportStats
  warnings: string[]
  error?: string
}

export interface ImportSummary {
  files: ImportFileResult[]
}

const emptyStats = (): ImportStats => ({
  rows: 0,
  tasks: 0,
  subtasks: 0,
  withDueDate: 0,
  comments: 0,
  sectionsFlattened: 0,
  skipped: 0
})

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : err ? String(err) : fallback

function projectNameFromPath(p: string): string {
  return (
    basename(p)
      .replace(/\.csv$/i, '')
      .trim() || 'Imported Todoist Project'
  )
}

async function planForFile(filePath: string, now: Date): Promise<ImportPlan> {
  const raw = await readFile(filePath, 'utf-8')
  const rows = parseTodoistCsv(raw)
  return mapRows(rows, projectNameFromPath(filePath), { now })
}

/** Parse each file and report what would be imported — performs no writes. */
export async function previewTodoistImport(
  filePaths: string[],
  now: Date = new Date()
): Promise<PreviewFile[]> {
  const out: PreviewFile[] = []
  for (const fp of filePaths) {
    try {
      const plan = await planForFile(fp, now)
      out.push({
        fileName: basename(fp),
        projectName: plan.project.name,
        stats: plan.stats,
        sampleTitles: plan.sampleTitles,
        warnings: plan.warnings.map((w) => w.message)
      })
    } catch (err) {
      out.push({
        fileName: basename(fp),
        projectName: '',
        stats: emptyStats(),
        sampleTitles: [],
        warnings: [],
        error: errorMessage(err, 'Failed to read file')
      })
    }
  }
  return out
}

/** Apply each file's plan: create a project, then its tasks (parents before children). */
export async function runTodoistImport(
  filePaths: string[],
  deps?: { domain?: ImportTasksDomain; now?: Date }
): Promise<ImportSummary> {
  const now = deps?.now ?? new Date()
  const domain: ImportTasksDomain = deps?.domain ?? (await defaultDomain())

  const files: ImportFileResult[] = []
  for (const fp of filePaths) {
    try {
      const plan = await planForFile(fp, now)
      const { project } = await domain.createProject({ name: plan.project.name })
      const idMap = new Map<string, string>()
      for (const t of plan.tasks) {
        const parentId = t.parentTempId ? (idMap.get(t.parentTempId) ?? null) : null
        const { task } = await domain.createTask({
          projectId: project.id,
          parentId,
          title: t.title,
          description: t.description,
          priority: t.priority,
          dueDate: t.dueDate,
          dueTime: t.dueTime,
          position: t.position
        })
        idMap.set(t.tempId, task.id)
      }
      files.push({
        projectName: plan.project.name,
        projectId: project.id,
        stats: plan.stats,
        warnings: plan.warnings.map((w) => w.message)
      })
    } catch (err) {
      logger.error('Todoist import failed for file', fp, err)
      files.push({
        projectName: projectNameFromPath(fp),
        projectId: null,
        stats: emptyStats(),
        warnings: [],
        error: errorMessage(err, 'Import failed')
      })
    }
  }
  return { files }
}
