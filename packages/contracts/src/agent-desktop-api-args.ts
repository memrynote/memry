/**
 * The arguments of every desktop API operation an agent can call through
 * `vault_desktop_read` / `vault_desktop_write`, as zod schemas. The bridge
 * validates each call against these before it reaches the window, the
 * `vault_desktop_describe` tool publishes them as JSON Schema, and the agent
 * API reference is generated from them.
 *
 * Each operation maps to its parameters in call order: `args[i]` is checked
 * against the i-th entry. Where the IPC handler parses an argument with a
 * contract schema, that schema is reused here, so the bridge refuses exactly
 * what the handler would. Every object refuses keys it does not name.
 */
import { z } from 'zod'

import type { AgentMcpDesktopOperation } from './agent-mcp-channels'
import {
  BookmarkBulkCreateSchema,
  BookmarkBulkDeleteSchema,
  BookmarkCheckSchema,
  BookmarkCreateSchema,
  BookmarkListSchema,
  BookmarkReorderSchema,
  BookmarkToggleSchema
} from './bookmarks-api'
import {
  CreateCalendarEventSchema,
  ListCalendarEventsSchema,
  UpdateCalendarEventSchema
} from './calendar-api'
import { CanvasCreateSchema, CanvasGetAssetSchema, CanvasListAssetsSchema } from './canvas-api'
import {
  DeleteViewRequestSchema,
  GetAvailablePropertiesRequestSchema,
  GetConfigRequestSchema,
  GetFolderSuggestionsRequestSchema,
  GetViewsRequestSchema,
  ListWithPropertiesRequestSchema,
  SetConfigRequestSchema,
  SetViewRequestSchema
} from './folder-view-api'
import { GraphSettingsSchema, LocalGraphRequestSchema } from './graph-api'
import { HomePageCreateSchema, HomePageReorderSchema, HomePageUpdateSchema } from './home-page-api'
import {
  BulkArchiveSchema,
  BulkFileSchema,
  BulkTagSchema,
  CaptureClipSchema,
  CaptureImageSchema,
  CaptureLinkSchema,
  CapturePdfSchema,
  CaptureTextSchema,
  CaptureVoiceSchema,
  FileItemSchema,
  GetFilingHistorySchema,
  InboxJobListSchema,
  InboxListSchema,
  InboxUpdateSchema,
  ListArchivedSchema,
  SnoozeSchema
} from './inbox-api'
import {
  CreateEntryInputSchema,
  DeleteEntryInputSchema,
  GetDayContextInputSchema,
  GetEntryInputSchema,
  GetHeatmapInputSchema,
  GetMonthEntriesInputSchema,
  GetYearStatsInputSchema,
  UpdateEntryInputSchema
} from './journal-api'
import {
  AddPropertyOptionSchema,
  AddStatusOptionSchema,
  ApplyTemplateSchema,
  CreatePropertyDefinitionSchema,
  DeletePropertyDefinitionSchema,
  EnsurePropertyDefinitionSchema,
  ExportNoteSchema,
  ImportFilesSchema,
  NoteCreateSchema,
  NoteGetPositionsSchema,
  NoteListSchema,
  NoteMoveSchema,
  NoteRenameSchema,
  NoteReorderSchema,
  NoteUpdateSchema,
  RemovePropertyOptionSchema,
  RenamePropertyOptionSchema,
  SetCalendarPropertyVisibilitySchema,
  SetLocalOnlySchema,
  UpdateOptionColorSchema,
  UpdatePropertyDefinitionSchema
} from './notes-api'
import { GetPropertiesSchema, RenamePropertySchema, SetPropertiesSchema } from './properties-api'
import {
  BulkDismissSchema,
  CreateReminderSchema,
  GetForTargetSchema,
  ListRemindersSchema,
  SnoozeReminderSchema,
  UpdateReminderSchema
} from './reminders-api'
import {
  SavedFilterCreateSchema,
  SavedFilterDeleteSchema,
  SavedFilterReorderSchema,
  SavedFilterUpdateSchema
} from './saved-filters-api'
import { AddReasonSchema, QuickSearchInputSchema, SearchQuerySchema } from './search-api'
import {
  BackupSettingsSchema,
  CalendarSettingsSchema,
  EditorSettingsSchema,
  FeaturesSettingsSchema,
  GeneralSettingsSchema,
  InboxSettingsSchema,
  KeyboardShortcutsSchema,
  SyncSettingsSchema,
  TaskSettingsSchema,
  VoiceTranscriptionSettingsSchema
} from './settings-schemas'
import { strictDeep } from './strict-schema'
import {
  GetNotesByTagSchema,
  MergeTagSchema,
  PinNoteToTagSchema,
  RemoveTagFromNoteSchema,
  RenameTagSchema,
  UnpinNoteFromTagSchema,
  UpdateTagColorSchema,
  UpdateTagIconSchema
} from './tags-api'
import {
  BulkIdsSchema,
  BulkMoveSchema,
  ConvertToSubtaskSchema,
  GetUpcomingSchema,
  ProjectCaptureUrlSchema,
  ProjectCreateSchema,
  ProjectImportFilesSchema,
  ProjectLinkItemSchema,
  ProjectListForItemSchema,
  ProjectReorderSchema,
  ProjectSetHomeNoteSchema,
  ProjectSetLinkPinnedSchema,
  ProjectUpdateSchema,
  RenameFolderSchema,
  StatusCreateSchema,
  StatusReorderSchema,
  StatusUpdateSchema,
  TaskCompleteSchema,
  TaskCreateSchema,
  TaskListSchema,
  TaskMoveSchema,
  TaskReorderSchema,
  TaskUpdateSchema
} from './tasks-api'
import {
  SetFolderConfigSchema,
  TemplateCreateSchema,
  TemplateDuplicateSchema,
  TemplateUpdateSchema
} from './templates-api'
import { DownloadRemoteVaultSchema, UpdateVaultConfigSchema } from './vault-api'

/** One operation's parameters, in call order. */
export type DesktopOperationParams = Readonly<Record<string, z.ZodType>>

const text = z.string()
const none = {} as const satisfies DesktopOperationParams

const calendarRangeInput = z.object({
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional()
})

export const AGENT_DESKTOP_OPERATION_PARAMS = {
  'notes.get': { id: text },
  'notes.getByPath': { path: text },
  'notes.getFile': { id: text },
  'notes.resolveByTitle': { title: text },
  'notes.resolveWikiTarget': { target: text },
  'notes.previewByTitle': { title: text },
  'notes.list': { options: NoteListSchema.optional() },
  'notes.getTags': none,
  'notes.getLinks': { id: text },
  'notes.getFolders': none,
  'notes.exists': { titleOrPath: text },
  'notes.getPropertyDefinitions': none,
  'notes.listAttachments': { noteId: text },
  'notes.getFolderConfig': { folderPath: text },
  'notes.getFolderTemplate': { folderPath: text },
  'notes.getVersions': { noteId: text },
  'notes.getVersion': { snapshotId: text },
  'notes.getPositions': { folderPath: NoteGetPositionsSchema.shape.folderPath },
  'notes.getAllPositions': none,
  'notes.getLocalOnlyCount': none,
  'notes.getCalendarPropertyNames': none,

  'tasks.get': { id: text },
  'tasks.list': { options: TaskListSchema.optional() },
  'tasks.getSubtasks': { parentId: text },
  'tasks.getProject': { id: text },
  'tasks.listProjects': none,
  'tasks.listStatuses': { projectId: text },
  'tasks.getTags': none,
  'tasks.getStats': none,
  'tasks.getToday': none,
  'tasks.getUpcoming': { days: GetUpcomingSchema.shape.days },
  'tasks.getOverdue': none,
  'tasks.getLinkedTasks': { noteId: text },
  'tasks.listProjectLinks': { projectId: text },
  'tasks.listProjectContents': { projectId: text },
  'tasks.listForItem': {
    itemType: ProjectListForItemSchema.shape.itemType,
    itemId: ProjectListForItemSchema.shape.itemId
  },

  'inbox.get': { id: text },
  'inbox.list': { options: InboxListSchema.optional() },
  'inbox.previewLink': { url: text },
  'inbox.getSuggestions': { itemId: text },
  'inbox.getTags': none,
  'inbox.getSnoozed': none,
  'inbox.getStats': none,
  'inbox.getJobs': { options: InboxJobListSchema.optional() },
  'inbox.getPatterns': none,
  'inbox.getStaleThreshold': none,
  'inbox.listArchived': { options: ListArchivedSchema.optional() },
  'inbox.getFilingHistory': { options: GetFilingHistorySchema.optional() },

  'journal.getEntry': { date: GetEntryInputSchema.shape.date },
  'journal.getHeatmap': { year: GetHeatmapInputSchema.shape.year },
  'journal.getMonthEntries': {
    year: GetMonthEntriesInputSchema.shape.year,
    month: GetMonthEntriesInputSchema.shape.month
  },
  'journal.getYearStats': { year: GetYearStatsInputSchema.shape.year },
  'journal.getDayContext': { date: GetDayContextInputSchema.shape.date },
  'journal.getAllTags': none,
  'journal.getStreak': none,
  'properties.get': { entityId: GetPropertiesSchema.shape.entityId },
  'templates.list': none,
  'templates.get': { id: text },
  'savedFilters.list': none,
  'bookmarks.get': { id: text },
  'bookmarks.list': { options: BookmarkListSchema.optional() },
  'bookmarks.isBookmarked': { input: BookmarkCheckSchema },
  'bookmarks.listByType': { itemType: text },
  'bookmarks.getByItem': { input: BookmarkCheckSchema },
  'tags.getNotesByTag': { input: GetNotesByTagSchema },
  'tags.getAllWithCounts': none,
  'tags.listCategories': none,
  'folderView.getConfig': { folderPath: GetConfigRequestSchema.shape.folderPath },
  'folderView.getViews': { scope: GetViewsRequestSchema.shape.scope },
  'folderView.listWithProperties': { options: ListWithPropertiesRequestSchema },
  'folderView.getAvailableProperties': { scope: GetAvailablePropertiesRequestSchema.shape.scope },
  'folderView.getFolderSuggestions': { noteId: GetFolderSuggestionsRequestSchema.shape.noteId },
  'folderView.folderExists': { folderPath: text },
  'reminders.get': { id: text },
  'reminders.list': { options: ListRemindersSchema.optional() },
  'reminders.getUpcoming': { days: z.number().optional() },
  'reminders.getDue': none,
  'reminders.getForTarget': { input: GetForTargetSchema },
  'reminders.countPending': none,

  'calendar.getEvent': { id: text },
  // The responder also reads options sent as a JSON string.
  'calendar.listEvents': { options: z.union([ListCalendarEventsSchema, z.string()]).optional() },
  // The responder takes { startAt, endAt } (or { start, end }), a YYYY-MM-DD
  // date meaning that whole local day, and still the older (start, end) pair.
  'calendar.getRange': {
    inputOrStart: z.union([calendarRangeInput, z.string()]),
    end: z.string().optional()
  },

  'settings.get': { key: text },
  'settings.getJournalSettings': none,
  'settings.getAISettings': none,
  'settings.getVoiceTranscriptionSettings': none,
  'settings.getVoiceModelStatus': none,
  'settings.getVoiceRecordingReadiness': none,
  'settings.getVoiceTranscriptionOpenAIKeyStatus': none,
  'settings.getAIModelStatus': none,
  'settings.getTabSettings': none,
  'settings.getNoteEditorSettings': none,
  'settings.getGeneralSettings': none,
  'settings.getEditorSettings': none,
  'settings.getTaskSettings': none,
  'settings.getKeyboardSettings': none,
  'settings.getSyncSettings': none,
  'settings.getBackupSettings': none,
  'settings.getGraphSettings': none,
  'settings.getCalendarSettings': none,
  'settings.getFeaturesSettings': none,
  'settings.getInboxSettings': none,

  'search.query': { params: SearchQuerySchema },
  'search.quick': {
    text: QuickSearchInputSchema.shape.text,
    noteFileTypes: QuickSearchInputSchema.shape.noteFileTypes
  },
  'search.getStats': none,
  'search.getReasons': none,
  'search.getAllTags': none,
  'graph.getData': none,
  'graph.getLocal': { params: LocalGraphRequestSchema },
  'homePages.list': none,
  'homePages.get': { id: text },
  'vault.getAll': none,
  'vault.getStatus': none,
  'vault.getConfig': none,
  'vault.listAccount': none,
  'canvas.list': none,
  'canvas.getAsset': {
    canvasId: CanvasGetAssetSchema.shape.canvasId,
    fileId: CanvasGetAssetSchema.shape.fileId
  },
  'canvas.listAssets': { canvasId: CanvasListAssetsSchema.shape.canvasId },
  'canvas.libraryList': none,

  'notes.create': { input: NoteCreateSchema },
  'notes.update': { input: NoteUpdateSchema },
  'notes.rename': { id: NoteRenameSchema.shape.id, newTitle: NoteRenameSchema.shape.newTitle },
  'notes.move': { id: NoteMoveSchema.shape.id, newFolder: NoteMoveSchema.shape.newFolder },
  'notes.delete': { id: text },
  'notes.createFolder': { path: text },
  'notes.renameFolder': {
    oldPath: RenameFolderSchema.shape.oldPath,
    newPath: RenameFolderSchema.shape.newPath
  },
  'notes.deleteFolder': { path: text },
  'notes.createPropertyDefinition': { input: CreatePropertyDefinitionSchema },
  'notes.updatePropertyDefinition': { input: UpdatePropertyDefinitionSchema },
  'notes.ensurePropertyDefinition': {
    name: EnsurePropertyDefinitionSchema.shape.name,
    type: EnsurePropertyDefinitionSchema.shape.type
  },
  'notes.addPropertyOption': {
    propertyName: AddPropertyOptionSchema.shape.propertyName,
    option: AddPropertyOptionSchema.shape.option
  },
  'notes.addStatusOption': {
    propertyName: AddStatusOptionSchema.shape.propertyName,
    categoryKey: AddStatusOptionSchema.shape.categoryKey,
    option: AddStatusOptionSchema.shape.option
  },
  'notes.removePropertyOption': {
    propertyName: RemovePropertyOptionSchema.shape.propertyName,
    optionValue: RemovePropertyOptionSchema.shape.optionValue
  },
  'notes.renamePropertyOption': {
    propertyName: RenamePropertyOptionSchema.shape.propertyName,
    oldValue: RenamePropertyOptionSchema.shape.oldValue,
    newValue: RenamePropertyOptionSchema.shape.newValue
  },
  'notes.updateOptionColor': {
    propertyName: UpdateOptionColorSchema.shape.propertyName,
    optionValue: UpdateOptionColorSchema.shape.optionValue,
    newColor: UpdateOptionColorSchema.shape.newColor
  },
  'notes.deletePropertyDefinition': { name: DeletePropertyDefinitionSchema.shape.name },
  'notes.uploadAttachment': {
    noteId: text,
    file: z
      .object({ name: z.string(), arrayBuffer: z.unknown() })
      .describe(
        'A File-like object whose arrayBuffer() returns the bytes. JSON cannot carry one, ' +
          'so an agent call to this operation fails.'
      )
  },
  'notes.deleteAttachment': { noteId: text, filename: text },
  'notes.setFolderConfig': { folderPath: text, config: SetFolderConfigSchema.shape.config },
  'notes.restoreVersion': { snapshotId: text },
  'notes.deleteVersion': { snapshotId: text },
  'notes.reorder': {
    folderPath: NoteReorderSchema.shape.folderPath,
    notePaths: NoteReorderSchema.shape.notePaths
  },
  'notes.importFiles': {
    sourcePaths: ImportFilesSchema.shape.sourcePaths,
    targetFolder: ImportFilesSchema.shape.targetFolder
  },
  'notes.setLocalOnly': {
    id: SetLocalOnlySchema.shape.id,
    localOnly: SetLocalOnlySchema.shape.localOnly
  },
  'notes.setCalendarPropertyVisibility': {
    name: SetCalendarPropertyVisibilitySchema.shape.name,
    showOnCalendar: SetCalendarPropertyVisibilitySchema.shape.showOnCalendar
  },
  'notes.applyTemplate': { input: ApplyTemplateSchema },
  'notes.exportPdf': { input: ExportNoteSchema },
  'notes.exportHtml': { input: ExportNoteSchema },

  'tasks.create': { input: TaskCreateSchema },
  'tasks.update': { input: TaskUpdateSchema },
  'tasks.delete': { id: text },
  'tasks.complete': { input: TaskCompleteSchema },
  'tasks.uncomplete': { id: text },
  'tasks.archive': { id: text },
  'tasks.unarchive': { id: text },
  'tasks.move': { input: TaskMoveSchema },
  'tasks.reorder': {
    taskIds: TaskReorderSchema.shape.taskIds,
    positions: TaskReorderSchema.shape.positions
  },
  'tasks.duplicate': { id: text },
  'tasks.convertToSubtask': {
    taskId: ConvertToSubtaskSchema.shape.taskId,
    parentId: ConvertToSubtaskSchema.shape.parentId
  },
  'tasks.convertToTask': { taskId: text },
  'tasks.createProject': { input: ProjectCreateSchema },
  'tasks.updateProject': { input: ProjectUpdateSchema },
  'tasks.deleteProject': { id: text },
  'tasks.archiveProject': { id: text },
  'tasks.reorderProjects': {
    projectIds: ProjectReorderSchema.shape.projectIds,
    positions: ProjectReorderSchema.shape.positions
  },
  'tasks.linkProjectItem': { input: ProjectLinkItemSchema },
  'tasks.unlinkProjectItem': { input: ProjectLinkItemSchema },
  'tasks.setProjectLinkPinned': { input: ProjectSetLinkPinnedSchema },
  'tasks.setProjectHomeNote': { input: ProjectSetHomeNoteSchema },
  'tasks.captureUrlToProject': { input: ProjectCaptureUrlSchema },
  'tasks.importFilesToProject': { input: ProjectImportFilesSchema },
  'tasks.createStatus': { input: StatusCreateSchema },
  // The preload sends `{ id, ...updates }`.
  'tasks.updateStatus': {
    id: StatusUpdateSchema.shape.id,
    updates: StatusUpdateSchema.omit({ id: true })
  },
  'tasks.deleteStatus': { id: text },
  'tasks.reorderStatuses': {
    statusIds: StatusReorderSchema.shape.statusIds,
    positions: StatusReorderSchema.shape.positions
  },
  'tasks.bulkComplete': { ids: BulkIdsSchema.shape.ids },
  'tasks.bulkDelete': { ids: BulkIdsSchema.shape.ids },
  'tasks.bulkMove': { ids: BulkMoveSchema.shape.ids, projectId: BulkMoveSchema.shape.projectId },
  'tasks.bulkArchive': { ids: BulkIdsSchema.shape.ids },

  'inbox.captureText': { input: CaptureTextSchema },
  'inbox.captureLink': { input: CaptureLinkSchema },
  'inbox.captureImage': { input: CaptureImageSchema },
  'inbox.captureVoice': { input: CaptureVoiceSchema },
  'inbox.captureClip': { input: CaptureClipSchema },
  'inbox.capturePdf': { input: CapturePdfSchema },
  'inbox.update': { input: InboxUpdateSchema },
  'inbox.archive': { id: text },
  'inbox.file': { input: FileItemSchema },
  'inbox.trackSuggestion': {
    input: z.object({
      itemId: z.string(),
      itemType: z.string(),
      suggestedTo: z.string(),
      actualTo: z.string(),
      confidence: z.number(),
      suggestedTags: z.array(z.string()).optional(),
      actualTags: z.array(z.string()).optional()
    })
  },
  'inbox.convertToNote': { itemId: text },
  'inbox.convertToTask': {
    itemId: text,
    input: z
      .object({
        projectId: z.string().optional(),
        dueDate: z.string().nullable().optional(),
        dueTime: z.string().nullable().optional(),
        priority: z.number().optional()
      })
      .optional()
  },
  'inbox.convertToEvent': {
    itemId: text,
    input: z.object({
      startAt: z.string(),
      endAt: z.string().nullable().optional(),
      isAllDay: z.boolean().optional(),
      location: z.string().nullable().optional()
    })
  },
  'inbox.convertToReminder': { itemId: text, input: z.object({ remindAt: z.string() }) },
  'inbox.linkToNote': { itemId: text, noteId: text, tags: z.array(z.string()).optional() },
  'inbox.addTag': { itemId: text, tag: text },
  'inbox.removeTag': { itemId: text, tag: text },
  'inbox.snooze': { input: SnoozeSchema },
  'inbox.unsnooze': { itemId: text },
  'inbox.markViewed': { itemId: text },
  'inbox.bulkFile': { input: BulkFileSchema },
  'inbox.bulkArchive': { input: BulkArchiveSchema },
  'inbox.bulkTag': { input: BulkTagSchema },
  'inbox.bulkSnooze': {
    input: z.object({
      itemIds: z.array(z.string()),
      snoozeUntil: z.string(),
      reason: z.string().optional()
    })
  },
  'inbox.fileAllStale': none,
  'inbox.retryTranscription': { itemId: text },
  'inbox.retryMetadata': { itemId: text },
  'inbox.setStaleThreshold': { days: z.number() },
  'inbox.unarchive': { id: text },
  'inbox.deletePermanent': { id: text },
  'inbox.undoFile': { id: text },
  'inbox.undoArchive': { id: text },

  'journal.createEntry': { input: CreateEntryInputSchema },
  'journal.updateEntry': { input: UpdateEntryInputSchema },
  'journal.deleteEntry': { date: DeleteEntryInputSchema.shape.date },
  'properties.set': {
    entityId: SetPropertiesSchema.shape.entityId,
    properties: SetPropertiesSchema.shape.properties
  },
  'properties.rename': {
    entityId: RenamePropertySchema.shape.entityId,
    oldName: RenamePropertySchema.shape.oldName,
    newName: RenamePropertySchema.shape.newName
  },
  'templates.create': { input: TemplateCreateSchema },
  'templates.update': { input: TemplateUpdateSchema },
  'templates.delete': { id: text },
  'templates.duplicate': {
    id: TemplateDuplicateSchema.shape.id,
    newName: TemplateDuplicateSchema.shape.newName
  },
  'savedFilters.create': { input: SavedFilterCreateSchema },
  'savedFilters.update': { input: SavedFilterUpdateSchema },
  'savedFilters.delete': { id: SavedFilterDeleteSchema.shape.id },
  'savedFilters.reorder': {
    ids: SavedFilterReorderSchema.shape.ids,
    positions: SavedFilterReorderSchema.shape.positions
  },
  'bookmarks.create': { input: BookmarkCreateSchema },
  'bookmarks.delete': { id: text },
  'bookmarks.toggle': { input: BookmarkToggleSchema },
  'bookmarks.reorder': { bookmarkIds: BookmarkReorderSchema.shape.bookmarkIds },
  'bookmarks.bulkDelete': { bookmarkIds: BookmarkBulkDeleteSchema.shape.bookmarkIds },
  'bookmarks.bulkCreate': { items: BookmarkBulkCreateSchema.shape.items },
  'tags.pinNoteToTag': { input: PinNoteToTagSchema },
  'tags.unpinNoteFromTag': { input: UnpinNoteFromTagSchema },
  'tags.renameTag': { input: RenameTagSchema },
  'tags.updateTagColor': { input: UpdateTagColorSchema },
  'tags.deleteTag': { tag: text },
  'tags.removeTagFromNote': { input: RemoveTagFromNoteSchema },
  'tags.mergeTag': { input: MergeTagSchema },
  'tags.updateTagIcon': { input: UpdateTagIconSchema },
  'tags.createCategory': { input: z.object({ name: z.string() }) },
  'tags.renameCategory': { input: z.object({ id: z.string(), name: z.string() }) },
  'tags.deleteCategory': { input: z.object({ id: z.string() }) },
  'tags.reorder': {
    input: z.object({
      tags: z
        .array(
          z.object({
            tag: z.string(),
            categoryId: z.string().nullable(),
            sortOrder: z.number()
          })
        )
        .optional(),
      categories: z.array(z.object({ id: z.string(), sortOrder: z.number() })).optional()
    })
  },
  'folderView.setConfig': {
    folderPath: SetConfigRequestSchema.shape.folderPath,
    config: SetConfigRequestSchema.shape.config
  },
  'folderView.setView': {
    scope: SetViewRequestSchema.shape.scope,
    view: SetViewRequestSchema.shape.view,
    previousName: SetViewRequestSchema.shape.previousName
  },
  'folderView.deleteView': {
    scope: DeleteViewRequestSchema.shape.scope,
    viewName: DeleteViewRequestSchema.shape.viewName
  },
  'reminders.create': { input: CreateReminderSchema },
  'reminders.update': { input: UpdateReminderSchema },
  'reminders.delete': { id: text },
  'reminders.dismiss': { id: text },
  'reminders.snooze': { input: SnoozeReminderSchema },
  'reminders.bulkDismiss': { input: BulkDismissSchema },
  'calendar.createEvent': { input: CreateCalendarEventSchema },
  'calendar.updateEvent': { input: UpdateCalendarEventSchema },
  'calendar.deleteEvent': { id: text },

  'settings.set': { key: text, value: text },
  'settings.setJournalSettings': {
    settings: z.object({
      defaultTemplate: z.string().nullable().optional(),
      weekdayTemplates: z.record(z.string(), z.string().nullable()).optional(),
      showSchedule: z.boolean().optional(),
      showTasks: z.boolean().optional(),
      showAIConnections: z.boolean().optional(),
      showStatsFooter: z.boolean().optional()
    })
  },
  'settings.setAISettings': { settings: z.object({ enabled: z.boolean().optional() }) },
  'settings.setVoiceTranscriptionSettings': {
    settings: VoiceTranscriptionSettingsSchema.partial()
  },
  'settings.setTabSettings': {
    settings: z.object({
      restoreSessionOnStart: z.boolean().optional(),
      tabCloseButton: z.enum(['always', 'hover', 'active']).optional()
    })
  },
  'settings.setNoteEditorSettings': {
    settings: z.object({ toolbarMode: z.enum(['floating', 'sticky']).optional() })
  },
  'settings.setGeneralSettings': { settings: GeneralSettingsSchema.partial() },
  'settings.setEditorSettings': { settings: EditorSettingsSchema.partial() },
  'settings.setTaskSettings': { settings: TaskSettingsSchema.partial() },
  'settings.setKeyboardSettings': { settings: KeyboardShortcutsSchema.partial() },
  'settings.resetKeyboardSettings': none,
  'settings.setSyncSettings': { settings: SyncSettingsSchema.partial() },
  'settings.setBackupSettings': { settings: BackupSettingsSchema.partial() },
  'settings.setGraphSettings': { settings: GraphSettingsSchema.partial() },
  'settings.setCalendarSettings': { settings: CalendarSettingsSchema.partial() },
  'settings.setFeaturesSettings': { settings: FeaturesSettingsSchema.partial() },
  'settings.setInboxSettings': { settings: InboxSettingsSchema.partial() },

  'search.rebuildIndex': none,
  'search.addReason': { params: AddReasonSchema },
  'search.clearReasons': none,
  'homePages.create': { input: HomePageCreateSchema },
  'homePages.update': { input: HomePageUpdateSchema },
  'homePages.delete': { id: text },
  'homePages.reorder': { ids: HomePageReorderSchema.shape.ids },
  'vault.switch': { vaultPath: text },
  'vault.reindex': none,
  'vault.updateConfig': { config: UpdateVaultConfigSchema },
  'vault.downloadRemote': {
    vaultUuid: DownloadRemoteVaultSchema.shape.vaultUuid,
    parentPath: DownloadRemoteVaultSchema.shape.parentPath
  },
  'canvas.create': { input: CanvasCreateSchema.optional() },
  'canvas.delete': { id: text }
} as const satisfies Record<AgentMcpDesktopOperation, DesktopOperationParams>

function paramsOf(operation: AgentMcpDesktopOperation): DesktopOperationParams {
  return AGENT_DESKTOP_OPERATION_PARAMS[operation]
}

/** A parameter the call may leave out: it has a default or accepts undefined. */
function isOptionalParam(schema: z.ZodType): boolean {
  return schema._zod.optin === 'optional'
}

export function desktopOperationParamNames(operation: AgentMcpDesktopOperation): string[] {
  return Object.keys(paramsOf(operation))
}

/**
 * Which parameters a call must pass. A tuple can only leave out trailing
 * arguments, so an optional parameter before a required one counts as required.
 */
export function desktopOperationRequiredCount(operation: AgentMcpDesktopOperation): number {
  const schemas = Object.values(paramsOf(operation))
  let count = schemas.length
  while (count > 0 && isOptionalParam(schemas[count - 1])) count -= 1
  return count
}

const argsSchemas = new Map<AgentMcpDesktopOperation, z.ZodType>()

/** The strict schema of an operation's `args` array. */
export function desktopOperationArgsSchema(operation: AgentMcpDesktopOperation): z.ZodType {
  let schema = argsSchemas.get(operation)
  if (!schema) {
    const items = Object.values(paramsOf(operation))
    schema = strictDeep(z.tuple(items as [z.ZodType, ...z.ZodType[]]))
    argsSchemas.set(operation, schema)
  }
  return schema
}

export interface DesktopArgsJsonSchema {
  [key: string]: unknown
  type: 'array'
  prefixItems?: Array<Record<string, unknown>>
  minItems: number
  maxItems: number
}

/**
 * The JSON Schema (draft 2020-12) of an operation's `args` array, for what the
 * caller sends: a parameter with a default shows as optional with its default.
 */
export function desktopOperationJsonSchema(
  operation: AgentMcpDesktopOperation
): DesktopArgsJsonSchema {
  const schema = z.toJSONSchema(desktopOperationArgsSchema(operation), {
    io: 'input',
    unrepresentable: 'any'
  }) as Record<string, unknown>
  return {
    ...schema,
    type: 'array',
    minItems: desktopOperationRequiredCount(operation),
    maxItems: desktopOperationParamNames(operation).length
  }
}
