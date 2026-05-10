import path from 'node:path'

import { searchAll } from '../../../database/queries/search'
import { listJournalEntriesInRange } from '../../../database/queries/notes'
import { getInboxProject } from '../../../database/queries/projects'
import { createDesktopInboxDomain } from '../../../inbox/domain'
import { readJournalEntry, writeJournalEntry } from '../../../vault/journal'
import { createNoteCommand, moveNoteCommand, updateNoteCommand } from '../../../notes/domain'
import { createDesktopTasksDomain } from '../../../tasks/domain'
import { createTasksPublisher } from '../../../tasks/publisher'
import { getFolders, getNoteById, listNotes } from '../../../vault/notes'
import { getConfig } from '../../../vault'
import { getAllTagsWithCounts } from '../../../tags/store'
import { generateId } from '../../../lib/id'
import type { DataDb, IndexDb } from '../../../database'
import { snapshotCurrentNoteFromWindow } from './current-note'
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
  const dir = toolPathFromVaultRelativePath(path.posix.dirname(notePath))
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

function defaultNotesFolder(): string {
  return normalizeFolderPath(getConfig().defaultNoteFolder) || 'notes'
}

function stripDefaultNotesFolder(vaultRelativePath: string): string {
  const normalized = normalizeFolderPath(vaultRelativePath)
  const notesFolder = defaultNotesFolder()

  if (normalized === notesFolder) return ''
  if (normalized.startsWith(`${notesFolder}/`)) {
    return normalized.slice(notesFolder.length + 1)
  }
  return normalized
}

function toolPathFromVaultRelativePath(vaultRelativePath: string): string {
  const stripped = stripDefaultNotesFolder(vaultRelativePath)
  return stripped ? `/${stripped}` : '/'
}

function internalFolderFromToolPath(toolPath: string | undefined): string | undefined {
  const stripped = stripDefaultNotesFolder(toolPath ?? '')
  return stripped || undefined
}

function cacheFolderFromToolPath(toolPath: string | undefined): string {
  const folder = internalFolderFromToolPath(toolPath)
  const notesFolder = defaultNotesFolder()
  return folder ? `${notesFolder}/${folder}` : notesFolder
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

export function createVaultServiceHandles({ dataDb, indexDb }: AdapterDeps): VaultServiceHandles {
  return {
    notes: {
      async search({ query, limit = 10, folderId }) {
        const result = searchAll(indexDb, dataDb, {
          text: query,
          types: ['note'],
          tags: [],
          dateRange: null,
          projectId: null,
          folderPath: folderId ? cacheFolderFromToolPath(folderId) : null,
          limit,
          offset: 0
        })
        const notes = result.groups.find((group) => group.type === 'note')?.results ?? []
        return notes.map<NoteSummary>((note) => {
          const metadata = note.metadata.type === 'note' ? note.metadata : null
          return {
            id: note.id,
            title: note.title,
            snippet: note.snippet ?? '',
            folder_path: metadata?.path ? folderPathFromNotePath(metadata.path) : null
          }
        })
      },
      async read(id) {
        const note = await getNoteById(id)
        if (!note) return null
        return {
          id: note.id,
          title: note.title,
          content_markdown: note.content,
          tags: note.tags,
          folder_path: folderPathFromNotePath(note.path),
          frontmatter: note.frontmatter
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
      async update(input) {
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
          folder: cacheFolderFromToolPath(folderPath),
          limit: 1000,
          offset: 0
        }).notes.filter((note) => {
          const toolPath = stripDefaultNotesFolder(note.path)
          return recursive || isDirectChild(basePath, toolPath)
        })

        const noteEntries: FolderEntry[] = notes.map((note) => ({
          kind: 'note',
          id: note.id,
          name: note.title,
          path: toolPathFromVaultRelativePath(note.path)
        }))

        return [...folderEntries, ...noteEntries]
      }
    },
    tasks: {
      async list(input) {
        const domain = createTaskDomain(dataDb)
        const includeCompleted = input.status === 'completed'
        const result = domain.listTasks({
          projectId: input.project_id,
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
      async create(input) {
        const projectId = input.project_id ?? getInboxProject(dataDb)?.id
        if (!projectId) {
          throw new Error('No project available for task creation')
        }

        const result = await createTaskDomain(dataDb).createTask({
          title: input.title,
          projectId,
          dueDate: input.due ?? null,
          priority: input.priority,
          description: input.notes ?? null,
          tags: input.tags
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

        const result = await domain.updateTask({
          id,
          title: patch.title,
          statusId: patch.status,
          projectId: patch.project_id ?? undefined,
          dueDate: patch.due,
          priority: patch.priority,
          description: patch.notes
        })
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to update task')
        }
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
        return result.projects.map<ProjectSummary>((project) => ({
          id: project.id,
          name: project.name,
          status: project.archivedAt ? 'archived' : 'active',
          task_count: project.taskCount
        }))
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
          .map<InboxSummary>((item) => ({
            id: item.id,
            source: item.sourceUrl ?? item.captureSource ?? item.type,
            title: item.title,
            snippet: item.content ?? item.transcription ?? item.excerpt ?? '',
            captured_at: item.createdAt.getTime()
          }))
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
      }
    },
    tags: {
      async listAll() {
        return getAllTagsWithCounts(indexDb, dataDb).map((tag) => ({
          name: tag.name,
          count: tag.count
        }))
      }
    },
    windows: {
      async snapshotCurrentNote(windowId) {
        return snapshotCurrentNoteFromWindow(windowId)
      }
    }
  }
}
