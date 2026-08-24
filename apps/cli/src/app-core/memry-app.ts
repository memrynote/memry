import type { OpenedDatabases } from './database.ts'
import type { AgentService } from './agent.ts'
import { createAgentService } from './agent.ts'
import type { BookmarksService } from '@memry/app-core/bookmarks'
import { createBookmarksService } from '@memry/app-core/bookmarks'
import type { CalendarService } from '@memry/app-core/calendar'
import { createCalendarService } from '@memry/app-core/calendar'
import { openDatabases } from './database.ts'
import type { FoldersService } from './folders.ts'
import { createFoldersService } from './folders.ts'
import type { FolderViewService } from './folder-view.ts'
import { createFolderViewService } from './folder-view.ts'
import type { GraphService } from '@memry/app-core/graph'
import { createGraphService } from '@memry/app-core/graph'
import type { InboxService } from './inbox.ts'
import { createInboxService } from './inbox.ts'
import type { LocaleService } from './locale.ts'
import { createLocaleService } from './locale.ts'
import type {
  AttachmentsService,
  ExportHtmlOptions,
  ExportPdfOptions,
  ImportFilesInput
} from './note-files.ts'
import {
  createAttachmentsService,
  createExportHtmlService,
  createExportPdfService,
  createExportMarkdownService,
  createImportFilesService
} from './note-files.ts'
import type { NotesService } from './notes.ts'
import { createNotesService } from './notes.ts'
import type { PropertiesService } from './properties.ts'
import { createPropertiesService } from './properties.ts'
import { ensureVaultLayout, writeVaultConfig, type VaultConfig } from './paths.ts'
import type { RemindersService } from '@memry/app-core/reminders'
import { createRemindersService } from '@memry/app-core/reminders'
import type { SettingsService } from '@memry/app-core/settings'
import { createSettingsService } from '@memry/app-core/settings'
import type { SavedFiltersService } from '@memry/app-core/saved-filters'
import { createSavedFiltersService } from '@memry/app-core/saved-filters'
import type { SearchReasonsService, SearchStats } from '@memry/app-core/search-tools'
import {
  createSearchReasonsService,
  createSearchStatsService,
  createSearchTagsService
} from '@memry/app-core/search-tools'
import type { TagsService } from '@memry/app-core/tags'
import { createTagsService } from '@memry/app-core/tags'
import type { SyncService } from './sync.ts'
import { createSyncService } from './sync.ts'
import type { TaskRecord, TasksService } from '@memry/app-core/tasks'
import { createTasksService } from '@memry/app-core/tasks'
import type { TemplatesService } from './templates.ts'
import { createTemplatesService } from './templates.ts'
import type { VersionsService } from './versions.ts'
import { createVersionsService } from './versions.ts'

export interface CreateMemryAppInput {
  vaultPath: string
}

export interface SearchResult {
  kind: 'note' | 'journal' | 'task' | 'inbox' | 'reminder' | 'template' | 'calendar'
  id: string
  title: string
  path?: string
  snippet?: string
}

export interface MemryApp {
  vault: {
    status(): { isOpen: true; path: string }
    config(): VaultConfig
    updateConfig(updates: Partial<VaultConfig>): Promise<VaultConfig>
  }
  notes: NotesService
  folders: FoldersService
  folderView: FolderViewService
  properties: PropertiesService
  journal: {
    get(date: string): Promise<Awaited<ReturnType<NotesService['getJournalByDate']>>>
    write(
      date: string,
      content: string
    ): Promise<Awaited<ReturnType<NotesService['upsertJournal']>>>
    append(
      date: string,
      content: string
    ): Promise<Awaited<ReturnType<NotesService['upsertJournal']>>>
    delete(date: string): Promise<boolean>
    month(year: number, month: number): Promise<Awaited<ReturnType<NotesService['list']>>>
    heatmap(year: number): Promise<Array<{ date: string; count: number; wordCount: number }>>
    yearStats(year: number): Promise<{ year: number; entries: number; words: number }>
    dayContext(date: string): Promise<{
      date: string
      tasks: Array<{
        id: string
        title: string
        completed: boolean
        priority?: 'low' | 'medium' | 'high' | 'urgent'
        isOverdue: boolean
      }>
      events: []
      overdueCount: number
    }>
    allTags(): Promise<Array<{ tag: string; count: number }>>
    streak(): Promise<{ current: number; longest: number }>
  }
  tasks: TasksService
  inbox: InboxService
  locale: LocaleService
  tags: TagsService
  reminders: RemindersService
  settings: SettingsService
  templates: TemplatesService
  bookmarks: BookmarksService
  savedFilters: SavedFiltersService
  calendar: CalendarService
  sync: SyncService
  agent: AgentService
  versions: VersionsService
  attachments: AttachmentsService
  importFiles(
    input: ImportFilesInput
  ): Promise<Awaited<ReturnType<ReturnType<typeof createImportFilesService>>>>
  exportHtml(
    noteId: string,
    targetPath: string,
    options?: ExportHtmlOptions
  ): Promise<Awaited<ReturnType<ReturnType<typeof createExportHtmlService>>>>
  exportPdf(
    noteId: string,
    targetPath: string,
    options?: ExportPdfOptions
  ): Promise<Awaited<ReturnType<ReturnType<typeof createExportPdfService>>>>
  exportMarkdown(
    noteId: string,
    targetPath: string
  ): Promise<Awaited<ReturnType<ReturnType<typeof createExportMarkdownService>>>>
  graph: GraphService
  searchStats(): Promise<SearchStats>
  searchReasons: SearchReasonsService
  searchTags(): Promise<string[]>
  search(query: string): Promise<SearchResult[]>
  close(): void
}

function taskMatches(task: TaskRecord, query: string): boolean {
  const haystack = `${task.title} ${task.description ?? ''} ${task.tags.join(' ')}`.toLowerCase()
  return haystack.includes(query)
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function previousDay(date: Date): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() - 1)
  return next
}

function priorityLabel(priority: number): 'low' | 'medium' | 'high' | 'urgent' | undefined {
  if (priority >= 4) return 'urgent'
  if (priority === 3) return 'high'
  if (priority === 2) return 'medium'
  if (priority === 1) return 'low'
  return undefined
}

export async function createMemryApp({ vaultPath }: CreateMemryAppInput): Promise<MemryApp> {
  const config = await ensureVaultLayout(vaultPath)
  const databases: OpenedDatabases = openDatabases(vaultPath)
  const notes = createNotesService({ vaultPath, config, dataDb: databases.dataDb })
  const folders = createFoldersService({ vaultPath, config })
  const folderView = createFolderViewService({ vaultPath, config, notes })
  const properties = createPropertiesService({ notes, dataDb: databases.dataDb, vaultPath })
  const tasks = createTasksService(databases.dataDb)
  const inbox = createInboxService({ dataDb: databases.dataDb, vaultPath, notes, tasks })
  const tags = createTagsService({ dataDb: databases.dataDb, notes })
  const reminders = createRemindersService(databases.dataDb)
  const settings = createSettingsService(databases.dataDb)
  const locale = createLocaleService({ vaultPath, settings })
  const templates = createTemplatesService({ vaultPath, dataDb: databases.dataDb })
  const bookmarks = createBookmarksService(databases.dataDb)
  const savedFilters = createSavedFiltersService(databases.dataDb)
  const calendar = createCalendarService(databases.dataDb)
  const sync = createSyncService({ dataDb: databases.dataDb, vaultPath, config })
  const agent = createAgentService(settings)
  const versions = createVersionsService({ vaultPath, indexDb: databases.indexDb, notes })
  const attachments = createAttachmentsService({
    vaultPath,
    config,
    notes,
    dataDb: databases.dataDb
  })
  const importFiles = createImportFilesService({ vaultPath, config, dataDb: databases.dataDb })
  const exportHtml = createExportHtmlService({ notes })
  const exportPdf = createExportPdfService({ notes })
  const exportMarkdown = createExportMarkdownService({ vaultPath, notes })
  const graph = createGraphService({ notes, tasks })
  const searchStats = createSearchStatsService({ notes, tasks, inbox })
  const searchReasons = createSearchReasonsService(databases.dataDb)
  const searchTags = createSearchTagsService({ tags, templates })

  return {
    vault: {
      status() {
        return { isOpen: true, path: vaultPath }
      },
      config() {
        return config
      },
      async updateConfig(updates) {
        const next = { ...config, ...updates }
        await writeVaultConfig(vaultPath, next)
        Object.assign(config, next)
        return config
      }
    },
    notes,
    folders,
    folderView,
    properties,
    journal: {
      get(date) {
        return notes.getJournalByDate(date)
      },
      write(date, content) {
        return notes.upsertJournal(date, content, 'write')
      },
      append(date, content) {
        return notes.upsertJournal(date, content, 'append')
      },
      async delete(date) {
        const journal = await notes.getJournalByDate(date)
        return journal ? notes.delete(journal.id) : false
      },
      async month(year, month) {
        const prefix = `${year}-${String(month).padStart(2, '0')}-`
        return (await notes.list({ journalOnly: true, limit: 10000 })).filter((entry) =>
          entry.journalDate?.startsWith(prefix)
        )
      },
      async heatmap(year) {
        return (await notes.list({ journalOnly: true, limit: 10000 }))
          .filter((entry) => entry.journalDate?.startsWith(`${year}-`))
          .map((entry) => ({
            date: entry.journalDate ?? entry.title,
            count: 1,
            wordCount: entry.wordCount
          }))
      },
      async yearStats(year) {
        const entries = (await notes.list({ journalOnly: true, limit: 10000 })).filter((entry) =>
          entry.journalDate?.startsWith(`${year}-`)
        )
        return {
          year,
          entries: entries.length,
          words: entries.reduce((total, entry) => total + entry.wordCount, 0)
        }
      },
      async dayContext(date) {
        const dueTasks = await tasks.today(date)
        const overdueCount = (await tasks.overdue(date)).length
        return {
          date,
          tasks: dueTasks.map((task) => ({
            id: task.id,
            title: task.title,
            completed: task.completedAt !== null,
            priority: priorityLabel(task.priority),
            isOverdue: false
          })),
          events: [],
          overdueCount
        }
      },
      async allTags() {
        const counts = new Map<string, number>()
        for (const entry of await notes.list({ journalOnly: true, limit: 10000 })) {
          for (const tag of entry.tags) {
            const normalized = tag.trim()
            if (!normalized) continue
            counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
          }
        }
        return [...counts.entries()]
          .sort((left, right) => left[0].localeCompare(right[0]))
          .map(([tag, count]) => ({ tag, count }))
      },
      async streak() {
        const dates = new Set(
          (await notes.list({ journalOnly: true, limit: 10000 }))
            .map((entry) => entry.journalDate)
            .filter((date): date is string => !!date)
        )

        let current = 0
        let cursor = new Date(`${dateKey(new Date())}T00:00:00.000Z`)
        while (dates.has(dateKey(cursor))) {
          current += 1
          cursor = previousDay(cursor)
        }

        let longest = 0
        let run = 0
        let previous: Date | null = null
        for (const date of [...dates].sort()) {
          const parsed = new Date(`${date}T00:00:00.000Z`)
          const expected = previous ? dateKey(previousDay(parsed)) : null
          run = previous && expected === dateKey(previous) ? run + 1 : 1
          longest = Math.max(longest, run)
          previous = parsed
        }

        return { current, longest }
      }
    },
    tasks,
    inbox,
    locale,
    tags,
    reminders,
    settings,
    templates,
    bookmarks,
    savedFilters,
    calendar,
    sync,
    agent,
    versions,
    attachments,
    importFiles,
    exportHtml,
    exportPdf,
    exportMarkdown,
    graph,
    searchStats,
    searchReasons,
    searchTags,
    async search(rawQuery) {
      const query = rawQuery.toLowerCase().trim()
      if (!query) return []

      const results: SearchResult[] = []
      for (const note of await notes.list({ limit: 1000 })) {
        const haystack = `${note.title} ${note.content} ${note.tags.join(' ')}`.toLowerCase()
        if (!haystack.includes(query)) continue
        results.push({
          kind: 'note',
          id: note.id,
          title: note.title,
          path: note.path,
          snippet: note.snippet
        })
      }

      for (const journal of await notes.list({ journalOnly: true, limit: 1000 })) {
        const haystack = `${journal.title} ${journal.content}`.toLowerCase()
        if (!haystack.includes(query)) continue
        results.push({
          kind: 'journal',
          id: journal.id,
          title: journal.title,
          path: journal.path,
          snippet: journal.snippet
        })
      }

      for (const task of await tasks.list({ includeCompleted: true, includeArchived: true })) {
        if (!taskMatches(task, query)) continue
        results.push({
          kind: 'task',
          id: task.id,
          title: task.title,
          snippet: task.description ?? undefined
        })
      }

      for (const item of (await inbox.list({ includeArchived: true })).items) {
        const haystack = `${item.title} ${item.content ?? ''} ${item.tags.join(' ')}`.toLowerCase()
        if (!haystack.includes(query)) continue
        results.push({
          kind: 'inbox',
          id: item.id,
          title: item.title,
          snippet: item.content ?? undefined
        })
      }

      for (const reminder of (await reminders.list({ limit: 1000 })).reminders) {
        const haystack =
          `${reminder.title ?? ''} ${reminder.note ?? ''} ${reminder.highlightText ?? ''}`.toLowerCase()
        if (!haystack.includes(query)) continue
        results.push({
          kind: 'reminder',
          id: reminder.id,
          title: reminder.title ?? reminder.targetId,
          snippet: reminder.note ?? reminder.highlightText ?? undefined
        })
      }

      for (const template of await templates.list()) {
        const haystack =
          `${template.name} ${template.description ?? ''} ${template.content} ${template.tags.join(' ')}`.toLowerCase()
        if (!haystack.includes(query)) continue
        results.push({
          kind: 'template',
          id: template.id,
          title: template.name,
          path: template.path,
          snippet: template.content.slice(0, 180)
        })
      }

      for (const event of await calendar.events.list({ includeArchived: true })) {
        const haystack =
          `${event.title} ${event.description ?? ''} ${event.location ?? ''}`.toLowerCase()
        if (!haystack.includes(query)) continue
        results.push({
          kind: 'calendar',
          id: event.id,
          title: event.title,
          snippet: event.description ?? event.location ?? undefined
        })
      }

      return results
    },
    close() {
      databases.close()
    }
  }
}
