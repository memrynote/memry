import type { OpenedDatabases } from './database.ts'
import type { AgentService } from './agent.ts'
import { createAgentService } from './agent.ts'
import type { AgentExtrasService } from './agent-extras.ts'
import { createAgentExtrasService } from './agent-extras.ts'
import type { CalendarExtrasService } from './calendar-extras.ts'
import { createCalendarExtrasService } from './calendar-extras.ts'
import type { AttachmentToolsService } from './attachment-tools.ts'
import { createAttachmentToolsService } from './attachment-tools.ts'
import type { NoteToolsService } from './note-tools.ts'
import { createNoteToolsService } from './note-tools.ts'
import type { PropertyToolsService } from './property-tools.ts'
import { createPropertyToolsService } from './property-tools.ts'
import type { InboxFilingService } from './inbox-filing.ts'
import { createInboxFilingService } from './inbox-filing.ts'
import type { SyncExtrasService } from './sync-extras.ts'
import { createSyncExtrasService } from './sync-extras.ts'
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
import { listHtmlBlockText } from '@memry/app-core/html-block-text'
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
import type { TagSchemaService } from './tag-schema.ts'
import { createTagSchemaService } from './tag-schema.ts'
import { journalPropertyRows } from './journal-properties.ts'
import { reindexSearch } from './reindex.ts'
import { createVaultAdminService, type VaultAdminService } from './vault-admin.ts'
import { createFtsSearch, SEARCH_CONTENT_KINDS, type SearchContentKind } from './search.ts'
import type { ProjectLinksService } from './project-links.ts'
import { createProjectLinksService } from './project-links.ts'
import type { TaskActivityService } from './task-activity.ts'
import { createTaskActivityService } from './task-activity.ts'
import type { SyncService } from './sync.ts'
import { createSyncService } from './sync.ts'
import type { TaskRecord, TasksService } from '@memry/app-core/tasks'
import { createTasksService } from '@memry/app-core/tasks'
import { withHeaderStatusSync } from './note-header-status.ts'
import type { TemplatesService } from './templates.ts'
import { createTemplatesService } from './templates.ts'
import type { CanvasService } from './canvas.ts'
import { createCanvasService } from './canvas.ts'
import type { CustomIconsService } from './custom-icons.ts'
import { createCustomIconsService } from './custom-icons.ts'
import type { HomePagesService } from './home-pages.ts'
import { createHomePagesService } from './home-pages.ts'
import type { ImportService } from './importers.ts'
import { createImportService } from './importers.ts'
import type { ReadwiseService } from './readwise.ts'
import { createReadwiseService } from './readwise.ts'
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

// Every field is optional and additive: with none set, `search` returns what it always did.
export interface SearchOptions {
  types?: SearchResult['kind'][]
  tags?: string[]
  from?: string
  to?: string
  projectId?: string
  folderPath?: string
  limit?: number
  offset?: number
}

// A search hit plus what the filters need; stripped before it leaves `search`.
interface SearchCandidate extends SearchResult {
  modifiedAt?: string
  tags?: string[]
  projectId?: string
}

function isContentKind(kind: SearchResult['kind']): kind is SearchContentKind {
  return (SEARCH_CONTENT_KINDS as readonly string[]).includes(kind)
}

// A bare `--to 2026-01-31` means the whole day, as a date picker would.
function endOfDay(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value
}

export interface MemryApp {
  vault: {
    status(): { isOpen: true; path: string }
    config(): VaultConfig
    updateConfig(updates: Partial<VaultConfig>): Promise<VaultConfig>
    reindex(): ReturnType<typeof reindexSearch>
    setIcon: VaultAdminService['setIcon']
    listActivity: VaultAdminService['listActivity']
    clearActivity: VaultAdminService['clearActivity']
    listLocks: VaultAdminService['listLocks']
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
    properties(from: string, to: string): ReturnType<typeof journalPropertyRows>
  }
  tasks: TasksService
  taskActivity: TaskActivityService
  projectLinks: ProjectLinksService
  inbox: InboxService
  locale: LocaleService
  tags: TagsService
  tagSchema: TagSchemaService
  reminders: RemindersService
  settings: SettingsService
  templates: TemplatesService
  bookmarks: BookmarksService
  savedFilters: SavedFiltersService
  calendar: CalendarService
  sync: SyncService
  agent: AgentService
  agentExtras: AgentExtrasService
  calendarExtras: CalendarExtrasService
  inboxFiling: InboxFilingService
  syncExtras: SyncExtrasService
  versions: VersionsService
  canvas: CanvasService
  homePages: HomePagesService
  customIcons: CustomIconsService
  importer: ImportService
  readwise: ReadwiseService
  attachments: AttachmentsService
  attachmentTools: AttachmentToolsService
  noteTools: NoteToolsService
  propertyTools: PropertyToolsService
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
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
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
  const notes = createNotesService({
    vaultPath,
    config,
    dataDb: databases.dataDb,
    indexDb: databases.indexDb
  })
  const folders = createFoldersService({ vaultPath, config })
  const folderView = createFolderViewService({ vaultPath, config, notes })
  const properties = createPropertiesService({ notes, dataDb: databases.dataDb, vaultPath })
  const tasks = withHeaderStatusSync(createTasksService(databases.dataDb), databases.dataDb, notes)
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
  const agentExtras = createAgentExtrasService({ dataDb: databases.dataDb, agent })
  const calendarExtras = createCalendarExtrasService({
    dataDb: databases.dataDb,
    indexDb: databases.indexDb,
    calendar
  })
  const inboxFiling = createInboxFilingService({
    dataDb: databases.dataDb,
    vaultPath,
    notes,
    folders,
    calendar,
    reminders,
    inbox
  })
  const syncExtras = createSyncExtrasService({ dataDb: databases.dataDb, vaultPath })
  const versions = createVersionsService({ vaultPath, indexDb: databases.indexDb, notes })
  const canvas = createCanvasService({ dataDb: databases.dataDb, vaultPath })
  const homePages = createHomePagesService(databases.dataDb)
  const customIcons = createCustomIconsService({ dataDb: databases.dataDb, vaultPath })
  const importer = createImportService({ notes })
  const readwise = createReadwiseService(databases.dataDb)
  const attachments = createAttachmentsService({
    vaultPath,
    notes,
    dataDb: databases.dataDb
  })
  const attachmentTools = createAttachmentToolsService({
    vaultPath,
    dataDb: databases.dataDb,
    notes,
    attachments
  })
  const noteTools = createNoteToolsService({
    vaultPath,
    dataDb: databases.dataDb,
    notes,
    templates
  })
  const propertyTools = createPropertyToolsService({
    vaultPath,
    dataDb: databases.dataDb,
    notes,
    properties
  })
  const importFiles = createImportFilesService({ vaultPath, config, dataDb: databases.dataDb })
  const taskActivity = createTaskActivityService(databases.dataDb)
  const projectLinks = createProjectLinksService({
    dataDb: databases.dataDb,
    notes,
    properties,
    importFiles,
    vaultPath
  })
  const exportHtml = createExportHtmlService({ notes })
  const exportPdf = createExportPdfService({ notes })
  const exportMarkdown = createExportMarkdownService({ vaultPath, notes })
  const graph = createGraphService({
    notes,
    tasks,
    htmlBlockText: (noteId) => listHtmlBlockText(databases.indexDb, noteId)
  })
  const searchStats = createSearchStatsService({ notes, tasks, inbox })
  const searchReasons = createSearchReasonsService(databases.dataDb)
  const tagSchema = createTagSchemaService({
    dataDb: databases.dataDb,
    indexDb: databases.indexDb,
    notes,
    properties,
    templates
  })
  const searchTags = createSearchTagsService({ tags, templates })
  const vaultAdmin = createVaultAdminService({ vaultPath, dataDb: databases.dataDb })
  const fts = createFtsSearch({ indexDb: databases.indexDb, dataDb: databases.dataDb })

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
      },
      reindex() {
        return reindexSearch({
          vaultPath,
          indexDb: databases.indexDb,
          dataDb: databases.dataDb
        })
      },
      setIcon: vaultAdmin.setIcon,
      listActivity: vaultAdmin.listActivity,
      clearActivity: vaultAdmin.clearActivity,
      listLocks: vaultAdmin.listLocks
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
      },
      properties(from, to) {
        return journalPropertyRows({ notes, properties }, from, to)
      }
    },
    tasks,
    taskActivity,
    projectLinks,
    inbox,
    locale,
    tags,
    tagSchema,
    reminders,
    settings,
    templates,
    bookmarks,
    savedFilters,
    calendar,
    sync,
    agent,
    agentExtras,
    calendarExtras,
    inboxFiling,
    syncExtras,
    versions,
    canvas,
    homePages,
    customIcons,
    importer,
    readwise,
    attachments,
    attachmentTools,
    noteTools,
    propertyTools,
    importFiles,
    exportHtml,
    exportPdf,
    exportMarkdown,
    graph,
    searchStats,
    searchReasons,
    searchTags,
    async search(rawQuery, options = {}) {
      const query = rawQuery.toLowerCase().trim()
      if (!query) return []

      const wanted = options.types?.length ? new Set(options.types) : null
      const contentFilters =
        !!options.tags?.length ||
        options.from !== undefined ||
        options.to !== undefined ||
        options.projectId !== undefined ||
        options.folderPath !== undefined
      const want = (kind: SearchResult['kind']): boolean =>
        (wanted === null || wanted.has(kind)) && (!contentFilters || isContentKind(kind))

      const candidates: SearchCandidate[] = []
      const seen = new Set<string>()
      const push = (candidate: SearchCandidate): void => {
        const key = `${candidate.kind}:${candidate.id}`
        if (seen.has(key)) return
        seen.add(key)
        candidates.push(candidate)
      }
      // Ranked FTS hits go first; the substring scan below adds what the index lacks.
      const pushFts = (kind: SearchContentKind): void => {
        for (const hit of fts.search(rawQuery, kind, 500)) {
          push({
            kind,
            id: hit.id,
            title: hit.title,
            path: hit.path,
            snippet: hit.snippet,
            modifiedAt: hit.modifiedAt,
            projectId: hit.projectId
          })
        }
      }

      if (want('note')) {
        pushFts('note')
        for (const note of await notes.list({ limit: 1000 })) {
          const haystack = `${note.title} ${note.content} ${note.tags.join(' ')}`.toLowerCase()
          if (!haystack.includes(query)) continue
          push({
            kind: 'note',
            id: note.id,
            title: note.title,
            path: note.path,
            snippet: note.snippet,
            modifiedAt: note.modifiedAt,
            tags: note.tags
          })
        }
      }

      if (want('journal')) {
        pushFts('journal')
        for (const journal of await notes.list({ journalOnly: true, limit: 1000 })) {
          const haystack = `${journal.title} ${journal.content}`.toLowerCase()
          if (!haystack.includes(query)) continue
          push({
            kind: 'journal',
            id: journal.id,
            title: journal.title,
            path: journal.path,
            snippet: journal.snippet,
            modifiedAt: journal.modifiedAt,
            tags: journal.tags
          })
        }
      }

      if (want('task')) {
        pushFts('task')
        for (const task of await tasks.list({ includeCompleted: true, includeArchived: true })) {
          if (!taskMatches(task, query)) continue
          push({
            kind: 'task',
            id: task.id,
            title: task.title,
            snippet: task.description ?? undefined,
            modifiedAt: task.modifiedAt,
            tags: task.tags,
            projectId: task.projectId
          })
        }
      }

      if (want('inbox')) {
        pushFts('inbox')
        for (const item of (await inbox.list({ includeArchived: true })).items) {
          const haystack =
            `${item.title} ${item.content ?? ''} ${item.tags.join(' ')}`.toLowerCase()
          if (!haystack.includes(query)) continue
          push({
            kind: 'inbox',
            id: item.id,
            title: item.title,
            snippet: item.content ?? undefined,
            modifiedAt: item.modifiedAt,
            tags: item.tags
          })
        }
      }

      if (want('reminder')) {
        for (const reminder of (await reminders.list({ limit: 1000 })).reminders) {
          const haystack =
            `${reminder.title ?? ''} ${reminder.note ?? ''} ${reminder.highlightText ?? ''}`.toLowerCase()
          if (!haystack.includes(query)) continue
          push({
            kind: 'reminder',
            id: reminder.id,
            title: reminder.title ?? reminder.targetId,
            snippet: reminder.note ?? reminder.highlightText ?? undefined
          })
        }
      }

      if (want('template')) {
        for (const template of await templates.list()) {
          const haystack =
            `${template.name} ${template.description ?? ''} ${template.content} ${template.tags.join(' ')}`.toLowerCase()
          if (!haystack.includes(query)) continue
          push({
            kind: 'template',
            id: template.id,
            title: template.name,
            path: template.path,
            snippet: template.content.slice(0, 180)
          })
        }
      }

      if (want('calendar')) {
        for (const event of await calendar.events.list({ includeArchived: true })) {
          const haystack =
            `${event.title} ${event.description ?? ''} ${event.location ?? ''}`.toLowerCase()
          if (!haystack.includes(query)) continue
          push({
            kind: 'calendar',
            id: event.id,
            title: event.title,
            snippet: event.description ?? event.location ?? undefined
          })
        }
      }

      let results = candidates
      if (contentFilters) {
        const wantedTags = (options.tags ?? []).map((tag) => tag.toLowerCase())
        const indexed = new Map<SearchContentKind, Set<string>>()
        const taggedIds = (kind: SearchContentKind): Set<string> => {
          let ids = indexed.get(kind)
          if (!ids) indexed.set(kind, (ids = fts.taggedIds(kind, options.tags ?? [])))
          return ids
        }
        const to = options.to === undefined ? undefined : endOfDay(options.to)
        results = candidates.filter((candidate) => {
          if (!isContentKind(candidate.kind)) return false
          if (wantedTags.length > 0) {
            const hasTag = candidate.tags
              ? candidate.tags.some((tag) => wantedTags.includes(tag.toLowerCase()))
              : false
            if (!hasTag && !taggedIds(candidate.kind).has(candidate.id)) return false
          }
          if (options.from !== undefined && (candidate.modifiedAt ?? '') < options.from)
            return false
          if (to !== undefined && (candidate.modifiedAt ?? '') > to) return false
          if (options.projectId !== undefined && candidate.projectId !== options.projectId) {
            return false
          }
          if (options.folderPath !== undefined) {
            const isNote = candidate.kind === 'note' || candidate.kind === 'journal'
            if (!isNote || !candidate.path?.startsWith(options.folderPath)) return false
          }
          return true
        })
      }

      const offset = options.offset ?? 0
      const page =
        options.limit === undefined
          ? results.slice(offset)
          : results.slice(offset, offset + options.limit)
      return page.map(({ kind, id, title, path, snippet }) => ({
        kind,
        id,
        title,
        ...(path === undefined ? {} : { path }),
        ...(snippet === undefined ? {} : { snippet })
      }))
    },
    close() {
      databases.close()
    }
  }
}
