/**
 * NotePlan 3 importer (orchestrator).
 *
 * Input is a NotePlan data folder (or one of its `Backups/<stamp>` copies,
 * which have the same shape). The pure `@memry/importers/noteplan` package
 * does all the parsing; this module does IO only:
 *
 *   Calendar/YYYYMMDD.txt        → a real Memry journal entry
 *   Calendar/YYYY-Wnn|MM|Qn|YYYY → notes under NotePlan/Calendar
 *   Notes/**                     → notes under NotePlan/<original tree>
 *   @Archive/**                  → notes under NotePlan/Archive
 *
 * NotePlan tasks (`*` lines) become real Memry task rows in the Inbox
 * project, linked back to the note they came from via `sourceNoteId`, and
 * embedded in the body as `- [ ] Title {task:<id>}`.
 *
 * @module import/noteplan/noteplan-importer
 */

import * as fs from 'fs/promises'
import type { Dirent } from 'fs'
import * as os from 'os'
import * as path from 'path'
import matter from 'gray-matter'
import { createNote } from '../../vault/notes-crud'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import {
  convertBody,
  firstHeading,
  mapFiles,
  mapProperties,
  parseTags,
  stripFirstHeading,
  taskPlaceholder
} from '@memry/importers/noteplan'
import type { ParsedTask, ScannedFile } from '@memry/importers/noteplan'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'
import { resolveCoLocatedAssets } from '../_shared/co-located-assets'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'

const logger = createLogger('NotePlanImport')

/** Directories NotePlan owns that hold nothing importable. */
const IGNORED_DIRS = new Set(['Filters', '@Trash', 'Plugins', 'Caches', '.git'])

/** Where the macOS app keeps its data, relative to the user's home. */
const MACOS_CONTAINER_REL =
  'Library/Containers/co.noteplan.NotePlan3/Data/Library/Application Support/co.noteplan.NotePlan3'

/**
 * Absolute path the folder picker opens at. `defaultPath` reaches
 * `dialog.showOpenDialog` verbatim, so it must be absolute — same shape as the
 * Apple Notes importer's `defaultContainerDir()`.
 */
function defaultContainerDir(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  return path.join(os.homedir(), MACOS_CONTAINER_REL)
}

/** Injected task-side effects, so the orchestration is testable without the DB. */
export interface NotePlanTaskDeps {
  createTask(a: {
    projectId: string
    title: string
    dueDate: string | null
    parentId: string | null
    sourceNoteId: string
  }): Promise<{ success: boolean; task?: { id: string } | null }>
  completeTask(a: { id: string; completedAt?: string }): Promise<unknown>
  archiveTask(id: string): Promise<unknown>
  getInboxProjectId(): string | undefined
}

/** Build the real (db-backed) task deps lazily so importing this module stays light. */
async function defaultTaskDeps(): Promise<NotePlanTaskDeps> {
  const { requireDatabase } = await import('../../database')
  const { createDesktopTasksDomain } = await import('../../tasks/domain')
  const { createTasksPublisher } = await import('../../tasks/publisher')
  const { generateId } = await import('../../lib/id')
  const { getInboxProject } = await import('@main/database/queries/projects')

  const db = requireDatabase()
  const domain = createDesktopTasksDomain(db, createTasksPublisher(), generateId)
  return {
    createTask: (a) =>
      domain.createTask({
        projectId: a.projectId,
        title: a.title,
        dueDate: a.dueDate,
        parentId: a.parentId,
        sourceNoteId: a.sourceNoteId
      }),
    completeTask: (a) => domain.completeTask(a),
    archiveTask: (id) => domain.archiveTask(id),
    getInboxProjectId: () => getInboxProject(db)?.id
  }
}

/** Walk one area directory, collecting every file under it. */
async function collectArea(
  dir: string,
  areaRoot: string,
  rootDir: string,
  area: ScannedFile['area'],
  out: ScannedFile[]
): Promise<void> {
  // `withFileTypes: true` yields `Dirent<string>[]`; inferring the annotation
  // from `typeof fs.readdir` picks the Buffer overload instead.
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await collectArea(absPath, areaRoot, rootDir, area, out)
    } else if (entry.isFile()) {
      if (entry.name === '.DS_Store') continue
      out.push({ relPath: path.relative(areaRoot, absPath), absPath, rootDir, area })
    }
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Find the importable areas under a selected folder. Accepts the NotePlan data
 * root, a `Backups/<stamp>` copy (same shape), or a bare `Notes` folder.
 */
async function scanSource(sourcePath: string, out: ScannedFile[]): Promise<void> {
  const areas: { dir: string; area: ScannedFile['area'] }[] = [
    { dir: path.join(sourcePath, 'Calendar'), area: 'calendar' },
    { dir: path.join(sourcePath, 'Notes'), area: 'notes' },
    { dir: path.join(sourcePath, '@Archive'), area: 'archive' }
  ]

  let matched = false
  for (const { dir, area } of areas) {
    if (await isDirectory(dir)) {
      matched = true
      await collectArea(dir, dir, sourcePath, area, out)
    }
  }

  // The user pointed straight at a notes folder — treat the whole selection
  // as the notes area.
  if (!matched) await collectArea(sourcePath, sourcePath, sourcePath, 'notes', out)
}

/**
 * Create a task row per parsed task and return the placeholder → `{task:id}`
 * substitutions. Tasks whose row could not be created lose their placeholder
 * (the checkbox stays, the id suffix does not) rather than leaving a dangling
 * `{np-task:…}` in the body.
 */
async function createTasks(
  tasks: ParsedTask[],
  noteId: string,
  projectId: string,
  deps: NotePlanTaskDeps,
  ctx: ImportContext
): Promise<Map<string, string>> {
  const realIds = new Map<string, string>()

  for (const task of tasks) {
    if (ctx.isCancelled()) break
    if (!task.title) {
      ctx.reportSkipped(task.tempId, 'Task has no title')
      continue
    }

    const parentId = task.parentTempId ? (realIds.get(task.parentTempId) ?? null) : null

    let created: Awaited<ReturnType<NotePlanTaskDeps['createTask']>>
    try {
      created = await deps.createTask({
        projectId,
        title: task.title,
        dueDate: task.dueDate,
        parentId,
        sourceNoteId: noteId
      })
    } catch (error) {
      ctx.reportFailed(task.title, error)
      continue
    }

    const id = created.task?.id
    if (!created.success || !id) {
      ctx.reportFailed(task.title, 'Task could not be created')
      continue
    }

    realIds.set(task.tempId, id)

    // The row already exists and is already mapped, so a failed state
    // transition must not escape: unwound to the caller it would abort the
    // note write and leave these rows pointing at a `sourceNoteId` that never
    // resolves. Report it and move on with the task open instead.
    try {
      if (task.state === 'done') {
        await deps.completeTask({ id, completedAt: task.completedAt ?? undefined })
      } else if (task.state === 'cancelled') {
        // Memry has no cancelled state; archiving is what the TickTick importer
        // does with the same concept.
        await deps.archiveTask(id)
      }
    } catch (error) {
      ctx.reportFailed(task.title, error)
    }
  }

  return realIds
}

/**
 * Swap every `{np-task:<tempId>}` placeholder for the real `{task:<id>}`
 * suffix. A tempId with no row (creation failed, or an empty title) has its
 * placeholder removed so the line stays a valid plain checkbox.
 */
function applyTaskIds(markdown: string, tasks: ParsedTask[], realIds: Map<string, string>): string {
  let out = markdown
  for (const task of tasks) {
    const placeholder = taskPlaceholder(task.tempId)
    const id = realIds.get(task.tempId)
    if (id) {
      // The `{task:<id>}` suffix is the shape `parseTaskBlockSuffix` and
      // `scanTaskCheckboxStates` in `@memry/shared/task-block` read back.
      out = out.split(placeholder).join(`{task:${id}}`)
    } else {
      // No row: drop the placeholder (and the space before it) so the line
      // stays a valid plain checkbox rather than leaking `{np-task:…}`.
      out = out.split(` ${placeholder}`).join('').split(placeholder).join('')
    }
  }
  return out
}

interface PreparedBody {
  title: string
  markdown: string
  tags: string[]
  properties: Record<string, unknown>
  tasks: ParsedTask[]
}

/** Frontmatter `tags` may be a list or a single string. */
function frontmatterTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

/**
 * @param stripHeading Remove the body's first H1. True for notes, whose title
 *   field carries that text — leaving it would render the title twice. False
 *   for journal entries, which are keyed by date and have no title field, so a
 *   stripped H1 would be deleted outright. `firstHeading` scans the whole body,
 *   not just line 1, so this is not limited to a leading heading.
 */
async function prepare(
  absPath: string,
  fallbackTitle: string,
  stripHeading: boolean
): Promise<PreparedBody> {
  const raw = await fs.readFile(absPath, 'utf8')
  const { data, content } = matter(raw)
  const frontmatter = data as Record<string, unknown>
  // `tags` is a first-class note field in Memry, not a property — lift it out
  // before mapping the rest, or it lands in the properties panel instead.
  const declaredTags = frontmatterTags(frontmatter.tags)
  const { tags: _ignored, ...rest } = frontmatter
  const { properties } = mapProperties(rest)

  const heading = firstHeading(content)
  const body = heading && stripHeading ? stripFirstHeading(content) : content

  const converted = convertBody(body)

  return {
    title: heading ?? fallbackTitle,
    markdown: converted.markdown,
    tags: [...new Set([...declaredTags, ...parseTags(body)])].sort(),
    properties,
    tasks: converted.tasks
  }
}

/**
 * The body pipeline both write loops share: resolve the file's co-located
 * assets, create its task rows, then swap every `{np-task:…}` placeholder for
 * the real id. The loops differ only in where `noteId` comes from and what
 * they finally write, so everything up to that point lives here.
 */
async function bodyForWrite(args: {
  prepared: PreparedBody
  absPath: string
  rootDir: string
  noteId: string
  /** Absent when there is no Inbox project: no rows, placeholders stripped. */
  projectId: string | undefined
  deps: NotePlanTaskDeps
  ctx: ImportContext
  realRoots: Map<string, string>
}): Promise<string> {
  const { prepared, absPath, rootDir, noteId, projectId, deps, ctx, realRoots } = args

  const markdown = await resolveCoLocatedAssets({
    body: prepared.markdown,
    noteId,
    noteAbsPath: absPath,
    rootDir,
    ctx,
    realRoots
  })

  const realIds = projectId
    ? await createTasks(prepared.tasks, noteId, projectId, deps, ctx)
    : new Map<string, string>()

  return applyTaskIds(markdown, prepared.tasks, realIds)
}

export async function runNotePlanImport(
  input: ImportInput,
  ctx: ImportContext,
  injected?: NotePlanTaskDeps
): Promise<ImportSummary> {
  const deps = injected ?? (await defaultTaskDeps())

  // ---- Phase 1: scan ----
  ctx.setPhase('scanning')
  ctx.status(IMPORT_STATUS.notePlanScanning)

  const scanned: ScannedFile[] = []
  for (const sourcePath of input.sourcePaths) {
    if (ctx.isCancelled()) return ctx.toSummary()
    await scanSource(sourcePath, scanned)
  }

  const plan = mapFiles(scanned)
  for (const skip of plan.skipped) ctx.reportSkipped(skip.item, skip.reason)

  const total = plan.notes.length + plan.journals.length
  ctx.reportProgress(0, total)
  if (ctx.isCancelled()) return ctx.toSummary()

  // ---- Phase 2: write ----
  ctx.setPhase('importing')
  const projectId = deps.getInboxProjectId()
  if (!projectId) {
    // Every task needs a project. Without an Inbox the notes still import, but
    // their tasks stay as plain checkboxes — say so rather than dropping them
    // silently.
    logger.warn('no inbox project — NotePlan tasks will import as plain checkboxes')
    ctx.reportSkipped('Tasks', 'No Inbox project to import tasks into')
  }
  const realRoots = new Map<string, string>()
  let done = 0

  for (const planned of plan.notes) {
    if (ctx.isCancelled()) return ctx.toSummary()
    try {
      // A note carries the H1 in its title field, so strip it from the body.
      const prepared = await prepare(planned.absPath, planned.title, true)
      ctx.status(importingItemStatus(prepared.title))

      const noteId = generateNoteId()
      const markdown = await bodyForWrite({
        prepared,
        absPath: planned.absPath,
        rootDir: planned.rootDir,
        noteId,
        projectId,
        deps,
        ctx,
        realRoots
      })

      const stat = await fs.stat(planned.absPath)
      await createNote({
        id: noteId,
        title: prepared.title,
        content: markdown,
        folder: planned.vaultFolder,
        tags: prepared.tags,
        properties: prepared.properties,
        created: stat.birthtime.toISOString(),
        modified: stat.mtime.toISOString()
      })
      ctx.reportImported()
    } catch (error) {
      logger.warn('noteplan note import failed', { absPath: planned.absPath })
      ctx.reportFailed(planned.absPath, error)
    }
    done++
    ctx.reportProgress(done, total)
  }

  const { createJournalEntry, resolveJournalEntryId } = await import('../../journal/create-entry')
  const { readJournalEntry } = await import('../../vault/journal')

  for (const planned of plan.journals) {
    if (ctx.isCancelled()) return ctx.toSummary()
    try {
      // The entry is keyed by date and has no title field, so keep the H1 in
      // the body — stripping it here would delete the text outright.
      const prepared = await prepare(planned.absPath, planned.date, false)
      ctx.status(importingItemStatus(planned.date))

      // A journal entry is user-authored: never overwrite one that already has
      // content. Append below a rule instead.
      const existing = await readJournalEntry(planned.date)
      // Must be the id the entry will actually settle on — tasks are created
      // with it as `sourceNoteId` before the entry is written.
      const noteId = resolveJournalEntryId(planned.date)

      const markdown = await bodyForWrite({
        prepared,
        absPath: planned.absPath,
        rootDir: planned.rootDir,
        noteId,
        projectId,
        deps,
        ctx,
        realRoots
      })

      const content =
        existing && existing.content.trim().length > 0
          ? `${existing.content.trim()}\n\n## Imported from NotePlan\n\n${markdown}`
          : markdown

      // `writeJournalEntryWithContent` *replaces* an existing entry's
      // properties whenever this argument is defined, so merge first — passing
      // the source file's properties straight through would silently drop the
      // user's own. Undefined when empty, which is what preserves them.
      const properties = { ...(existing?.properties ?? {}), ...prepared.properties }

      await createJournalEntry({
        date: planned.date,
        content,
        tags: [...new Set([...(existing?.tags ?? []), ...prepared.tags])],
        properties: Object.keys(properties).length > 0 ? properties : undefined
      })
      ctx.reportImported()
    } catch (error) {
      logger.warn('noteplan journal import failed', { absPath: planned.absPath })
      ctx.reportFailed(planned.absPath, error)
    }
    done++
    ctx.reportProgress(done, total)
  }

  ctx.setPhase('done')
  return ctx.toSummary()
}

export const notePlanImporter: Importer = {
  id: 'noteplan',
  name: 'NotePlan',
  descriptionKey: 'import.sources.noteplan',
  fileSpec: {
    label: 'NotePlan folder',
    extensions: [],
    allowMultiple: false,
    directory: true,
    defaultPath: defaultContainerDir(),
    message:
      'Select your NotePlan folder — either the app’s data folder or one of its Backups copies.'
  },
  run: (input, ctx) => runNotePlanImport(input, ctx)
}
