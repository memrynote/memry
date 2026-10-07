import { searchAll } from '../../../database/queries/search'
import { getNoteCacheById } from '../../../database/queries/notes'
import { getInboxProject, getProjectLinkCounts } from '../../../database/queries/projects'
import {
  readAttachmentText,
  TEXT_BEARING_FILE_TYPES
} from '../../../database/queries/extracted-text'
import { EXTRACTED_TEXT_REPLY_CHARS, extractedTextReply } from './extracted-text-reply'
import { createDesktopInboxCrudHandlers, createDesktopInboxDomain } from '../../../inbox/domain'
import {
  createNoteCommand,
  deleteNoteCommand,
  moveNoteCommand,
  renameFolderCommand,
  renameNoteCommand,
  updateNoteCommand
} from '../../../notes/domain'
import { replaceNoteTagsInCrdt } from '../../../sync/crdt-feed'
import { getCrdtProvider } from '../../../sync/crdt-provider'
import { createDesktopTasksDomain } from '../../../tasks/domain'
import { createTasksPublisher } from '../../../tasks/publisher'
import {
  createFolder,
  deleteFolder,
  getFolders,
  getNoteById,
  listNotes
} from '../../../vault/notes'
import { getAllTagsWithCounts, listTagCategories } from '../../../tags/store'
import { generateId, generateNoteId } from '../../../lib/id'
import {
  syncFolderConfigCreate,
  syncFolderConfigDelete,
  syncFolderConfigRename
} from '../../../notes/folder-config-effects'
import type { RepeatConfig } from '@memry/domain-tasks'
import type { DataDb, IndexDb } from '../../../database'
import { AgentToolError } from '../errors'
import { saveAttachment } from '../../../vault/attachments'
import { emitNoteAttachmentSaved } from '../../../notes/runtime-effects'
import { serializeFileBlockMarker } from '../../../import/_shared/attachment-markdown'
import { snapshotCurrentNoteFromWindow } from './current-note'
import { assertSpatialCanvasEnabled, isCanvasOperation } from './canvas-flag'
import { createCanvasHandles } from './canvas-handles'
import { createJournalHandles } from './journal-handles'
import {
  folderPathFromNotePath,
  internalFolderFromToolPath,
  isDirectChild,
  normalizeFolderPath,
  toFolderEntry
} from './folder-paths'
import { createdTasksReply, withAgentChecklists, writeAgentBody } from './agent-checklists'
import { invokeDesktopApiFromWindow } from './desktop-api'
import { writeAndReadBack } from './desktop-api-readback'
import { noteFileFrontmatter, noteIcon, readStoredNote, readStoredStatus } from './stored-records'
import { withoutFileBodies } from './desktop-api-reply'
import { assertNoteWritable } from '../../../vault-locks/registry'
import { storedNoteBody } from './stored-body'
import { viewVaultFile } from './file-view'
import { openPdfDocument } from '../../../file-text/pdf-host'
import { prepareViewImageInImageProcess } from '../../../image-processing/bridge'
import { getStatus } from '../../../vault'
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

function isTextBearing(fileType: string): boolean {
  return (TEXT_BEARING_FILE_TYPES as readonly string[]).includes(fileType)
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

function sameTagList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index])
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
  const fileRowOf = (id: string) => getNoteCacheById(indexDb, id)
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
      async read(id, options) {
        const cached = getNoteCacheById(indexDb, id)
        if (!cached) return null

        const fileType = cached.fileType ?? 'markdown'
        if (fileType !== 'markdown') {
          // Filed binary (#800): reading it off disk would only hand `parseNote`
          // bytes to mangle. A PDF or image carries the text extracted from it;
          // audio and video carry identity + file type only, so the tool layer
          // can refuse them — the empty body never reaches an agent (#919).
          return {
            id: cached.id,
            title: cached.title,
            content_markdown: '',
            tags: [],
            folder_path: folderPathFromNotePath(cached.path),
            frontmatter: {},
            file_type: fileType,
            ...(cached.emoji ? { icon: cached.emoji } : {}),
            ...(isTextBearing(fileType)
              ? { extracted_text: extractedTextReply(indexDb, id, options?.fromPage ?? 1) }
              : {})
          }
        }

        const note = await getNoteById(id)
        if (!note) return null
        const icon = noteIcon(note)
        const attachments = readAttachmentText(indexDb, id, EXTRACTED_TEXT_REPLY_CHARS)
        return {
          id: note.id,
          title: note.title,
          content_markdown: note.content,
          tags: note.tags,
          folder_path: folderPathFromNotePath(note.path),
          frontmatter: note.frontmatter,
          file_type: 'markdown',
          ...(icon ? { icon } : {}),
          ...(attachments.files.length > 0
            ? {
                attachment_text: attachments.files,
                ...(attachments.truncated ? { attachment_text_truncated: true } : {})
              }
            : {})
        }
      },
      async create(input) {
        // Preset so a checkbox line converted during the write can link to it.
        const id = generateNoteId()
        let written = input.content_markdown
        const { result: note, createdTasks } = await writeAgentBody(
          id,
          input.content_markdown,
          '',
          (content) => {
            written = content
            return createNoteCommand({
              id,
              title: input.title,
              content,
              folder: internalFolderFromToolPath(input.folder_path),
              tags: input.tags
            })
          }
        )
        return {
          id: note.id,
          body: await storedNoteBody(note.id, written),
          ...createdTasksReply(createdTasks)
        }
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
        // `updateNoteCommand` feeds the new body to the note's CRDT doc.
        let nextContent = note.content
        const { result: updated, createdTasks } = await writeAgentBody(
          input.id,
          input.content_markdown,
          input.mode === 'replace' ? note.content : '',
          (content) => {
            nextContent = mergeContent(note.content, input.mode, content)
            return updateNoteCommand({ id: input.id, content: nextContent })
          }
        )

        // Inline `#hashtag`s in the new body change the note's tag set, and
        // write-back treats the Y.Doc tag array as authoritative — without this
        // it would put the pre-edit tags back into the frontmatter.
        if (!sameTagList(note.tags, updated.tags)) {
          replaceNoteTagsInCrdt(input.id, updated.tags)
        }
        return {
          ...(await storedNoteBody(input.id, nextContent)),
          ...createdTasksReply(createdTasks)
        }
      },
      async saveHtmlAttachment({ id, title, html }) {
        assertNoteWritable(id)
        const fileType = getNoteCacheById(indexDb, id)?.fileType ?? 'markdown'
        if (fileType !== 'markdown') {
          throw new AgentToolError(
            'VALIDATION',
            `Note ${id} is a filed ${fileType} file, not a markdown note.`,
            { id, file_type: fileType }
          )
        }
        const result = await saveAttachment(id, Buffer.from(html, 'utf8'), `${title}.html`)
        if (!result.success || !result.path) {
          throw new Error(result.error ?? 'Failed to save HTML artifact')
        }
        if (result.diskPath) emitNoteAttachmentSaved(id, result.diskPath)
        return { marker: serializeFileBlockMarker(result), url: result.path }
      },
      async addTag({ id, tag }) {
        const note = await getNoteById(id)
        if (!note) {
          throw new Error(`Note not found: ${id}`)
        }
        const nextTag = tag.trim()
        const tags = note.tags.includes(nextTag) ? note.tags : [...note.tags, nextTag]
        const updated = await updateNoteCommand({ id, tags })
        // Same reason as the body path above: a live Y.Doc's tag array wins at
        // write-back, so a tag only written to the file is reverted.
        replaceNoteTagsInCrdt(id, updated.tags)
      },
      async removeTag({ id, tag }) {
        const note = await getNoteById(id)
        if (!note) {
          throw new Error(`Note not found: ${id}`)
        }
        const normalized = tag.trim().toLowerCase()
        const updated = await updateNoteCommand({
          id,
          tags: note.tags.filter((existing) => existing.toLowerCase() !== normalized)
        })
        replaceNoteTagsInCrdt(id, updated.tags)
      },
      async moveToFolder({ id, folder_path }) {
        await moveNoteCommand(id, internalFolderFromToolPath(folder_path) ?? '')
      },
      async stored(id) {
        return readStoredNote(indexDb, id, folderPathFromNotePath)
      },
      storedBody: storedNoteBody
    },
    folders: {
      async list({ path: folderPath, id, recursive }) {
        const basePath = normalizeFolderPath(folderPath ?? id)
        const folders = (await getFolders())
          .map((folder) => normalizeFolderPath(folder.path))
          .filter(Boolean)
        if (basePath && !folders.includes(basePath)) {
          throw new AgentToolError(
            'NOT_FOUND',
            `Folder not found: ${basePath}. List the vault root (omit path) to see the folders that exist.`,
            { path: basePath }
          )
        }
        const folderEntries = folders
          .filter((folder) => {
            if (!basePath) return recursive ? true : isDirectChild('', folder)
            return recursive ? folder.startsWith(`${basePath}/`) : isDirectChild(basePath, folder)
          })
          .map(toFolderEntry)

        const notes = listNotes({
          folder: basePath || undefined,
          limit: 1000,
          offset: 0
        }).notes.filter((note) => {
          const toolPath = normalizeFolderPath(note.path)
          return recursive || isDirectChild(basePath, toolPath)
        })

        const noteEntries: FolderEntry[] = notes.map((note) => {
          const fileType = note.fileType ?? 'markdown'
          return {
            kind: fileType === 'markdown' ? 'note' : 'file',
            id: note.id,
            name: note.title,
            path: normalizeFolderPath(note.path),
            file_type: fileType,
            ...(note.emoji ? { icon: note.emoji } : {})
          }
        })

        return [...folderEntries, ...noteEntries]
      },
      async create(folderPath) {
        const internal = internalFolderFromToolPath(folderPath) ?? ''
        await createFolder(internal)
        syncFolderConfigCreate(internal)
        return { path: internal }
      },
      async rename({ old_path, new_path }) {
        const oldInternal = internalFolderFromToolPath(old_path) ?? ''
        const newInternal = internalFolderFromToolPath(new_path) ?? ''
        await renameFolderCommand(oldInternal, newInternal)
        syncFolderConfigRename(oldInternal, newInternal)
        return { path: newInternal }
      },
      async delete(folderPath) {
        const internal = internalFolderFromToolPath(folderPath) ?? ''
        await deleteFolder(internal)
        syncFolderConfigDelete(internal)
        return { path: internal }
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
      get: async (id) => readStoredStatus(dataDb, id),
      async create(input) {
        const result = await createTaskDomain(dataDb).createStatus({
          projectId: input.project_id,
          name: input.name,
          color: input.color,
          isDone: input.is_done
        })
        assertSuccess(result, 'Failed to create status')
        return { ...result.status, id: result.status?.id ?? '' }
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
        return { ...result.status, id: input.id }
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
    journal: createJournalHandles(indexDb),
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
        return withoutFileBodies(await invokeDesktopApiFromWindow(windowId, input), fileRowOf)
      },
      prepareWrite: withAgentChecklists,
      async write(input, windowId) {
        if (isCanvasOperation(input.operation)) assertSpatialCanvasEnabled()
        return writeAndReadBack(
          input,
          async (request) =>
            withoutFileBodies(
              await invokeDesktopApiFromWindow(windowId, await withAgentChecklists(request)),
              fileRowOf
            ),
          (entityId) => noteFileFrontmatter(indexDb, entityId)
        )
      }
    },
    windows: {
      async snapshotCurrentNote(windowId) {
        return snapshotCurrentNoteFromWindow(windowId)
      }
    },
    sync: {
      crdtStoreAvailable: async () => getCrdtProvider().isPersistent()
    },
    files: {
      async view(input) {
        const vaultPath = getStatus().path
        if (!vaultPath) throw new AgentToolError('NOT_FOUND', 'No vault is open')
        return viewVaultFile(
          {
            vaultPath,
            fileRow: fileRowOf,
            prepareImage: prepareViewImageInImageProcess,
            openPdf: openPdfDocument
          },
          input
        )
      }
    }
  }
}
