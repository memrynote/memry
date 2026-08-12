import path from 'node:path'

import { searchAll } from '../../../database/queries/search'
import { getNoteCacheById, listJournalEntriesInRange } from '../../../database/queries/notes'
import { getInboxProject, getProjectLinkCounts } from '../../../database/queries/projects'
import { createDesktopInboxDomain } from '../../../inbox/domain'
import { createDesktopInboxCrudHandlers } from '../../../inbox/domain'
import { deleteJournalEntryFile, readJournalEntry, writeJournalEntry } from '../../../vault/journal'
import {
  createNoteCommand,
  deleteNoteCommand,
  moveNoteCommand,
  renameNoteCommand,
  updateNoteCommand
} from '../../../notes/domain'
import { createDesktopTasksDomain } from '../../../tasks/domain'
import { createTasksPublisher } from '../../../tasks/publisher'
import {
  createFolder,
  deleteFolder,
  getFolders,
  getNoteById,
  listNotes,
  renameFolder
} from '../../../vault/notes'
import { getAllTagsWithCounts, listTagCategories } from '../../../tags/store'
import { generateId } from '../../../lib/id'
import {
  syncFolderConfigDelete,
  syncFolderConfigRename
} from '../../../notes/folder-config-effects'
import type { RepeatConfig } from '@memry/domain-tasks'
import type { DataDb, IndexDb } from '../../../database'
import { AgentToolError } from '../errors'
import { snapshotCurrentNoteFromWindow } from './current-note'
import { assertSpatialCanvasEnabled, isCanvasOperation } from './canvas-flag'
import { createCanvasHandles } from './canvas-handles'
import { invokeDesktopApiFromWindow } from './desktop-api'
import type {
  FolderEntry,
  InboxSummary,
  NoteSummary,
  ProjectSummary,
  TaskSummary,
  VaultServiceHandles
} from './handles'

export interface AdapterDeps {
  dataDb: DataDb
  indexDb: IndexDb
}

function folderPathFromNotePath(notePath: string): string | null {
  // `dirname` reports '.' for a note sitting directly in the vault root, which
  // is reachable now that folder paths are vault-relative (#1204).
  const parent = path.posix.dirname(notePath)
  const dir = toolPathFromVaultRelativePath(parent === '.' ? '' : parent)
  return dir === '/' ? null : dir
}

function mergeContent(
  current: string,
  mode: 'append' | 'prepend' | 'replace',
  next: string
): string {
  if (mode === 'replace') return next
  if (!current) return next
  if (!next) return current
  return mode === 'append' ? `${current}\n\n${next}` : `${next}\n\n${current}`
}

function normalizeFolderPath(value: string | undefined): string {
  return (value ?? '').replace(/^\/+|\/+$/g, '')
}

// Tool paths are vault-relative with a leading slash ("/projects/active").
// `defaultNoteFolder` is not part of this mapping: it names where a new note
// goes, not where folders live, so an agent must see the same tree the sidebar
// does (#1204).
function toolPathFromVaultRelativePath(vaultRelativePath: string): string {
  const stripped = normalizeFolderPath(vaultRelativePath)
  return stripped ? `/${stripped}` : '/'
}

function internalFolderFromToolPath(toolPath: string | undefined): string | undefined {
  return normalizeFolderPath(toolPath ?? '') || undefined
}

function isDirectChild(basePath: string, candidatePath: string): boolean {
  const normalizedBase = normalizeFolderPath(basePath)
  const normalizedCandidate = normalizeFolderPath(candidatePath)

  if (!normalizedBase) {
    return !normalizedCandidate.includes('/')
  }

  if (!normalizedCandidate.startsWith(`${normalizedBase}/`)) {
    return false
  }

  return !normalizedCandidate.slice(normalizedBase.length + 1).includes('/')
}

function toFolderEntry(folderPath: string): FolderEntry {
  const toolPath = `/${normalizeFolderPath(folderPath)}`
  return {
    kind: 'folder',
    id: toolPath,
    name: path.posix.basename(folderPath),
    path: toolPath
  }
}

function taskStatusLabel(task: { statusId: string | null; completedAt?: string | null }): string {
  if (task.completedAt) return 'completed'
  return task.statusId ?? 'open'
}

function createTaskDomain(dataDb: DataDb) {
  return createDesktopTasksDomain(dataDb, createTasksPublisher(), generateId)
}

function assertSuccess(result: { success: boolean; error?: string }, fallback: string): void {
  if (!result.success) {
    throw new Error(result.error ?? fallback)
  }
}

function inboxVisualType(item: {
  type?: string
  sourceUrl?: string | null
  metadata?: unknown
}): string | undefined {
  if (item.type === 'clip') return 'quote'

  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : null
  const platform =
    metadata && 'platform' in metadata && typeof metadata.platform === 'string'
      ? metadata.platform
      : null

  if (item.type === 'social' && platform === 'twitter') return 'twitter'
  if ((item.type === 'social' || item.type === 'link') && item.sourceUrl) {
    try {
      const host = new URL(item.sourceUrl).hostname.toLowerCase()
      if (
        host === 'x.com' ||
        host.endsWith('.x.com') ||
        host === 'twitter.com' ||
        host.endsWith('.twitter.com')
      ) {
        return 'twitter'
      }
    } catch {
      return item.type === 'social' ? 'social' : undefined
    }
  }

  return item.type === 'social' ? 'social' : undefined
}

export function createVaultServiceHandles({ dataDb, indexDb }: AdapterDeps): VaultServiceHandles {
  return {
    notes: {
      async search({ query, limit = 10, folderId, fileTypes }) {
        const result = searchAll(indexDb, dataDb, {
          text: query,
          types: ['note'],
          tags: [],
          dateRange: null,
          projectId: null,
          folderPath: folderId ? (internalFolderFromToolPath(folderId) ?? null) : null,
          limit,
          offset: 0,
          // Filtering inside the FTS query keeps `limit` counting eligible rows
          // only, so filed binaries can't starve markdown notes out (#874).
          noteFileTypes: fileTypes
        })
        const notes = result.groups.find((group) => group.type === 'note')?.results ?? []
        return notes.map<NoteSummary>((note) => {
          const metadata = note.metadata.type === 'note' ? note.metadata : null
          return {
            id: note.id,
            title: note.title,
            snippet: note.snippet ?? '',
            folder_path: metadata?.path ? folderPathFromNotePath(metadata.path) : null,
            file_type: metadata?.fileType ?? 'markdown',
            ...(metadata?.emoji ? { icon: metadata.emoji } : {})
          }
        })
      },
      async read(id) {
        const cached = getNoteCacheById(indexDb, id)
        if (!cached) return null

        const fileType = cached.fileType ?? 'markdown'
        if (fileType !== 'markdown') {
          // Filed binary (#800): reading it off disk would only hand `parseNote`
          // bytes to mangle. Return identity + file type so the tool layer can
          // refuse it — the empty body never reaches an agent (#919).
          return {
            id: cached.id,
            title: cached.title,
            content_markdown: '',
            tags: [],
            folder_path: folderPathFromNotePath(cached.path),
            frontmatter: {},
            file_type: fileType,
            ...(cached.emoji ? { icon: cached.emoji } : {})
          }
        }

        const note = await getNoteById(id)
        if (!note) return null
        const icon =
          typeof note.emoji === 'string'
            ? note.emoji
            : typeof note.frontmatter.emoji === 'string'
              ? note.frontmatter.emoji
              : null
        return {
          id: note.id,
          title: note.title,
          content_markdown: note.content,
          tags: note.tags,
          folder_path: folderPathFromNotePath(note.path),
          frontmatter: note.frontmatter,
          file_type: 'markdown',
          ...(icon ? { icon } : {})
        }
      },
      async create(input) {
        const note = await createNoteCommand({
          title: input.title,
          content: input.content_markdown,
          folder: internalFolderFromToolPath(input.folder_path),
          tags: input.tags
        })
        return { id: note.id }
      },
      async rename({ id, title }) {
        await renameNoteCommand(id, title)
        return { id }
      },
      async delete(id) {
        await deleteNoteCommand(id)
        return { id }
      },
      async update(input) {
        // A filed pdf/image/audio/video indexes as a "note" row (#800), so an
        // agent can reach one from search. Writing markdown over it would
        // destroy the user's file — refuse before touching disk (#919).
        const fileType = getNoteCacheById(indexDb, input.id)?.fileType ?? 'markdown'
        if (fileType !== 'markdown') {
          throw new AgentToolError(
            'VALIDATION',
            `Note ${input.id} is a filed ${fileType} file, not a markdown note. ` +
              'Writing markdown to it would destroy the file.',
            { id: input.id, file_type: fileType }
          )
        }

        const note = await getNoteById(input.id)
        if (!note) {
          throw new Error(`Note not found: ${input.id}`)
        }
        await updateNoteCommand({
          id: input.id,
          content: mergeContent(note.content, input.mode, input.content_markdown)
        })
      },
      async addTag({ id, tag }) {
        const note = await getNoteById(id)
        if (!note) {
          throw new Error(`Note not found: ${id}`)
        }
        const nextTag = tag.trim()
        const tags = note.tags.includes(nextTag) ? note.tags : [...note.tags, nextTag]
        await updateNoteCommand({ id, tags })
      },
      async removeTag({ id, tag }) {
        const note = await getNoteById(id)
        if (!note) {
          throw new Error(`Note not found: ${id}`)
        }
        const normalized = tag.trim().toLowerCase()
        await updateNoteCommand({
          id,
          tags: note.tags.filter((existing) => existing.toLowerCase() !== normalized)
        })
      },
      async moveToFolder({ id, folder_path }) {
        await moveNoteCommand(id, internalFolderFromToolPath(folder_path) ?? '')
      }
    },
    folders: {
      async list({ path: folderPath, recursive }) {
        const basePath = internalFolderFromToolPath(folderPath) ?? ''
        const folders = await getFolders()
        const folderEntries = folders
          .map((folder) => normalizeFolderPath(folder.path))
          .filter((folder) => {
            if (!folder) return false
            if (!basePath) return recursive ? true : isDirectChild('', folder)
            return recursive ? folder.startsWith(`${basePath}/`) : isDirectChild(basePath, folder)
          })
          .map(toFolderEntry)

        const notes = listNotes({
          folder: internalFolderFromToolPath(folderPath),
          limit: 1000,
          offset: 0
        }).notes.filter((note) => {
          const toolPath = normalizeFolderPath(note.path)
          return recursive || isDirectChild(basePath, toolPath)
        })

        const noteEntries: FolderEntry[] = notes.map((note) => ({
          kind: 'note',
          id: note.id,
          name: note.title,
          path: toolPathFromVaultRelativePath(note.path),
          ...(note.emoji ? { icon: note.emoji } : {})
        }))

        return [...folderEntries, ...noteEntries]
      },
      async create(folderPath) {
        await createFolder(internalFolderFromToolPath(folderPath) ?? '')
        return { path: folderPath }
      },
      async rename({ old_path, new_path }) {
        const oldInternal = internalFolderFromToolPath(old_path) ?? ''
        const newInternal = internalFolderFromToolPath(new_path) ?? ''
        await renameFolder(oldInternal, newInternal)
        syncFolderConfigRename(oldInternal, newInternal)
        return { path: new_path }
      },
      async delete(folderPath) {
        const internal = internalFolderFromToolPath(folderPath) ?? ''
        await deleteFolder(internal)
        syncFolderConfigDelete(internal)
        return { path: folderPath }
      }
    },
    tasks: {
      async list(input) {
        const domain = createTaskDomain(dataDb)
        const includeCompleted = input.status === 'completed'
        const result = domain.listTasks({
          projectId: input.project_id ?? undefined,
          statusId:
            input.status && input.status !== 'completed' && input.status !== 'open'
              ? input.status
              : undefined,
          includeCompleted,
          dueBefore: input.due_before,
          tags: input.tag ? [input.tag] : undefined,
          limit: input.limit
        })

        return result.tasks
          .filter((task) => {
            if (input.status === 'completed') return task.completedAt !== null
            if (input.status === 'open') return task.completedAt === null
            return true
          })
          .map<TaskSummary>((task) => ({
            id: task.id,
            title: task.title,
            status: taskStatusLabel(task),
            due: task.dueDate,
            project: task.projectId,
            tags: task.tags ?? []
          }))
      },
      async get(id) {
        return createTaskDomain(dataDb).getTask(id) ?? null
      },
      async create(input) {
        const projectId = input.project_id ?? getInboxProject(dataDb)?.id
        if (!projectId) {
          throw new Error('No project available for task creation')
        }

        const result = await createTaskDomain(dataDb).createTask({
          title: input.title,
          projectId,
          statusId: input.status_id ?? null,
          parentId: input.parent_id ?? null,
          dueDate: input.due_date ?? input.due ?? null,
          dueTime: input.due_time ?? null,
          startDate: input.start_date ?? null,
          priority: input.priority,
          description: input.description ?? input.notes ?? null,
          repeatConfig: input.repeat_config as RepeatConfig | null | undefined,
          repeatFrom: input.repeat_from ?? null,
          tags: input.tags,
          linkedNoteIds: input.linked_note_ids,
          sourceNoteId: input.source_note_id ?? null,
          position: input.position
        })

        if (!result.success || !result.task) {
          throw new Error('Failed to create task')
        }

        return { id: result.task.id }
      },
      async update(id, patch) {
        const domain = createTaskDomain(dataDb)
        if (patch.status === 'completed') {
          const result = await domain.completeTask({ id })
          if (!result.success) throw new Error(result.error ?? 'Failed to complete task')
          return
        }
        if (patch.status === 'open') {
          const result = await domain.uncompleteTask(id)
          if (!result.success) throw new Error(result.error ?? 'Failed to reopen task')
          return
        }

        const dueDate = Object.prototype.hasOwnProperty.call(patch, 'due_date')
          ? patch.due_date
          : patch.due
        const description = Object.prototype.hasOwnProperty.call(patch, 'description')
          ? patch.description
          : patch.notes
        const result = await domain.updateTask({
          id,
          title: patch.title,
          statusId: patch.status_id ?? patch.status,
          projectId: patch.project_id ?? undefined,
          parentId: patch.parent_id,
          dueDate,
          dueTime: patch.due_time,
          startDate: patch.start_date,
          priority: patch.priority,
          description,
          repeatConfig: patch.repeat_config as RepeatConfig | null | undefined,
          repeatFrom: patch.repeat_from,
          tags: patch.tags,
          linkedNoteIds: patch.linked_note_ids
        })
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to update task')
        }
      },
      async delete(id) {
        const result = await createTaskDomain(dataDb).deleteTask(id)
        assertSuccess(result, 'Failed to delete task')
        return { id }
      },
      async complete({ id, completed_at }) {
        const result = await createTaskDomain(dataDb).completeTask({
          id,
          completedAt: completed_at
        })
        assertSuccess(result, 'Failed to complete task')
        return { id }
      },
      async uncomplete(id) {
        const result = await createTaskDomain(dataDb).uncompleteTask(id)
        assertSuccess(result, 'Failed to reopen task')
        return { id }
      },
      async archive(id) {
        const result = await createTaskDomain(dataDb).archiveTask(id)
        assertSuccess(result, 'Failed to archive task')
        return { id }
      },
      async unarchive(id) {
        const result = await createTaskDomain(dataDb).unarchiveTask(id)
        assertSuccess(result, 'Failed to unarchive task')
        return { id }
      },
      async move(input) {
        const result = await createTaskDomain(dataDb).moveTask({
          taskId: input.task_id,
          targetProjectId: input.target_project_id,
          targetStatusId: input.target_status_id,
          targetParentId: input.target_parent_id,
          position: input.position
        })
        assertSuccess(result, 'Failed to move task')
        return { id: input.task_id }
      },
      async reorder({ task_ids, positions }) {
        const result = await createTaskDomain(dataDb).reorderTasks(task_ids, positions)
        assertSuccess(result, 'Failed to reorder tasks')
        return { ids: task_ids }
      },
      async duplicate(id) {
        const result = await createTaskDomain(dataDb).duplicateTask(id)
        assertSuccess(result, 'Failed to duplicate task')
        return { id: result.task?.id ?? id }
      },
      async convertToSubtask({ task_id, parent_id }) {
        const result = await createTaskDomain(dataDb).convertToSubtask(task_id, parent_id)
        assertSuccess(result, 'Failed to convert task to subtask')
        return { id: task_id }
      },
      async convertToTask(id) {
        const result = await createTaskDomain(dataDb).convertToTask(id)
        assertSuccess(result, 'Failed to convert subtask to task')
        return { id }
      },
      async addTag({ id, tag }) {
        const domain = createTaskDomain(dataDb)
        const task = domain.getTask(id)
        if (!task) throw new Error(`Task not found: ${id}`)
        const tags = task.tags?.includes(tag) ? task.tags : [...(task.tags ?? []), tag]
        const result = await domain.updateTask({ id, tags })
        if (!result.success) throw new Error(result.error ?? 'Failed to add task tag')
      },
      async removeTag({ id, tag }) {
        const domain = createTaskDomain(dataDb)
        const task = domain.getTask(id)
        if (!task) throw new Error(`Task not found: ${id}`)
        const normalized = tag.toLowerCase()
        const result = await domain.updateTask({
          id,
          tags: (task.tags ?? []).filter((existing) => existing.toLowerCase() !== normalized)
        })
        if (!result.success) throw new Error(result.error ?? 'Failed to remove task tag')
      }
    },
    projects: {
      async list() {
        const result = createTaskDomain(dataDb).listProjects()
        // One aggregate for the whole list: a per-project contents call would
        // be an N+1 on a tool the model calls before most project writes.
        const linkCounts = getProjectLinkCounts(dataDb)
        return result.projects.map<ProjectSummary>((project) => ({
          id: project.id,
          name: project.name,
          status: project.archivedAt ? 'archived' : 'active',
          task_count: project.taskCount,
          icon: project.icon ?? null,
          home_note_id: project.homeNoteId ?? null,
          linked_counts: linkCounts.get(project.id) ?? { notes: 0, files: 0, events: 0 }
        }))
      },
      async get(id) {
        return createTaskDomain(dataDb).getProject(id) ?? null
      },
      async create(input) {
        const result = await createTaskDomain(dataDb).createProject(input)
        assertSuccess(result, 'Failed to create project')
        return { id: result.project?.id ?? '' }
      },
      async update(input) {
        const result = await createTaskDomain(dataDb).updateProject(input)
        assertSuccess(result, 'Failed to update project')
        return { id: input.id }
      },
      async delete(id) {
        const result = await createTaskDomain(dataDb).deleteProject(id)
        assertSuccess(result, 'Failed to delete project')
        return { id }
      },
      async archive(id) {
        const result = await createTaskDomain(dataDb).archiveProject(id)
        assertSuccess(result, 'Failed to archive project')
        return { id }
      },
      async reorder({ project_ids, positions }) {
        const result = await createTaskDomain(dataDb).reorderProjects(project_ids, positions)
        assertSuccess(result, 'Failed to reorder projects')
        return { ids: project_ids }
      }
    },
    statuses: {
      async list(projectId) {
        return createTaskDomain(dataDb).listStatuses(projectId)
      },
      async create(input) {
        const result = await createTaskDomain(dataDb).createStatus({
          projectId: input.project_id,
          name: input.name,
          color: input.color,
          isDone: input.is_done
        })
        assertSuccess(result, 'Failed to create status')
        return { id: result.status?.id ?? '' }
      },
      async update(input) {
        const result = await createTaskDomain(dataDb).updateStatus({
          id: input.id,
          name: input.name,
          color: input.color,
          position: input.position,
          isDefault: input.is_default,
          isDone: input.is_done
        })
        assertSuccess(result, 'Failed to update status')
        return { id: input.id }
      },
      async delete(id) {
        const result = await createTaskDomain(dataDb).deleteStatus(id)
        assertSuccess(result, 'Failed to delete status')
        return { id }
      },
      async reorder({ status_ids, positions }) {
        const result = await createTaskDomain(dataDb).reorderStatuses(status_ids, positions)
        assertSuccess(result, 'Failed to reorder statuses')
        return { ids: status_ids }
      }
    },
    journal: {
      async getByDate(date) {
        const entry = await readJournalEntry(date)
        if (!entry) return null
        return {
          id: entry.id,
          date: entry.date,
          content_markdown: entry.content
        }
      },
      async listInRange({ from, to }) {
        return listJournalEntriesInRange(indexDb, from, to).map((entry) => ({
          id: entry.id,
          date: entry.date ?? '',
          title: entry.title
        }))
      },
      async createIfMissing({ date, content_markdown }) {
        const existing = await readJournalEntry(date)
        if (existing) return { id: existing.id, created: false }

        const created = await writeJournalEntry(date, content_markdown)
        return { id: created.id, created: true }
      },
      async update({ date, content_markdown, tags, properties }) {
        const existing = await readJournalEntry(date)
        const updated = await writeJournalEntry(
          date,
          content_markdown ?? existing?.content ?? '',
          tags ?? existing?.tags,
          properties ?? existing?.properties
        )
        return { id: updated.id }
      },
      async delete(date) {
        return { date, deleted: await deleteJournalEntryFile(date) }
      }
    },
    inbox: {
      async list({ unread_only }) {
        const result = await createDesktopInboxDomain().list({
          limit: 100,
          offset: 0,
          sortBy: 'created',
          sortOrder: 'desc'
        })
        return result.items
          .filter((item) => !unread_only || !item.viewedAt)
          .map<InboxSummary>((item) => {
            const visualType = inboxVisualType(item)
            return {
              id: item.id,
              type: item.type,
              ...(visualType ? { visual_type: visualType } : {}),
              source: item.sourceUrl ?? item.captureSource ?? item.type,
              title: item.title,
              snippet: item.content ?? item.transcription ?? item.excerpt ?? '',
              captured_at: item.createdAt.getTime()
            }
          })
      },
      async get(id) {
        return createDesktopInboxCrudHandlers().handleGet(id)
      },
      async add({ source, title, content }) {
        const result = await createDesktopInboxDomain().captureText({
          title,
          content,
          source: source === 'api' ? 'api' : 'inline',
          force: true
        })
        if (!result.success || !result.item) {
          throw new Error(result.error ?? 'Failed to add inbox item')
        }
        return { id: result.item.id }
      },
      async update(input) {
        const result = await createDesktopInboxCrudHandlers().handleUpdate(input)
        assertSuccess(result, 'Failed to update inbox item')
        return { id: input.id }
      },
      async snooze({ id, snooze_until, reason }) {
        const result = await createDesktopInboxDomain().snooze({
          itemId: id,
          snoozeUntil: snooze_until,
          reason
        })
        assertSuccess(result, 'Failed to snooze inbox item')
        return { id }
      },
      async archive(id) {
        const result = await createDesktopInboxCrudHandlers().handleArchive(id)
        assertSuccess(result, 'Failed to archive inbox item')
        return { id }
      },
      async unarchive(id) {
        const result = await createDesktopInboxCrudHandlers().handleUnarchive(id)
        assertSuccess(result, 'Failed to unarchive inbox item')
        return { id }
      },
      async delete(id) {
        const result = await createDesktopInboxCrudHandlers().handleDeletePermanent(id)
        assertSuccess(result, 'Failed to delete inbox item')
        return { id }
      },
      async addTag({ id, tag }) {
        const result = await createDesktopInboxCrudHandlers().handleAddTag(id, tag)
        assertSuccess(result, 'Failed to add inbox tag')
        return { id }
      },
      async removeTag({ id, tag }) {
        const result = await createDesktopInboxCrudHandlers().handleRemoveTag(id, tag)
        assertSuccess(result, 'Failed to remove inbox tag')
        return { id }
      }
    },
    tags: {
      async listAll() {
        const categoryNames = new Map(listTagCategories(dataDb).map((c) => [c.id, c.name]))
        return getAllTagsWithCounts(indexDb, dataDb).map((tag) => ({
          name: tag.name,
          count: tag.count,
          color: tag.color ?? null,
          icon: tag.icon ?? null,
          category_id: tag.categoryId ?? null,
          category_name: tag.categoryId ? (categoryNames.get(tag.categoryId) ?? null) : null,
          sort_order: tag.sortOrder ?? 0
        }))
      }
    },
    canvas: createCanvasHandles(dataDb),
    desktop: {
      async read(input, windowId) {
        // The escape hatch must honour the same flag as the dedicated canvas
        // tools, or an agent could reach canvas.* with the feature off.
        if (isCanvasOperation(input.operation)) assertSpatialCanvasEnabled()
        return invokeDesktopApiFromWindow(windowId, input)
      },
      async write(input, windowId) {
        if (isCanvasOperation(input.operation)) assertSpatialCanvasEnabled()
        return invokeDesktopApiFromWindow(windowId, input)
      }
    },
    windows: {
      async snapshotCurrentNote(windowId) {
        return snapshotCurrentNoteFromWindow(windowId)
      }
    }
  }
}
