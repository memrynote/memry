import { z } from 'zod'
import type { AgentMcpDesktopOperation } from '@memry/contracts/agent-mcp-channels'
import {
  BookmarkBulkCreateSchema,
  BookmarkCheckSchema,
  BookmarkCreateSchema,
  BookmarkListSchema,
  BookmarkToggleSchema
} from '@memry/contracts/bookmarks-api'
import {
  CreateCalendarEventSchema,
  ListCalendarEventsSchema,
  UpdateCalendarEventSchema
} from '@memry/contracts/calendar-api'
import { CanvasCreateSchema } from '@memry/contracts/canvas-api'
import {
  DeleteViewRequestSchema,
  GetAvailablePropertiesRequestSchema,
  GetViewsRequestSchema,
  ListWithPropertiesRequestSchema,
  SetConfigRequestSchema,
  SetViewRequestSchema
} from '@memry/contracts/folder-view-api'
import { GraphSettingsSchema, LocalGraphRequestSchema } from '@memry/contracts/graph-api'
import { HomePageCreateSchema, HomePageUpdateSchema } from '@memry/contracts/home-page-api'
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
} from '@memry/contracts/inbox-api'
import { CreateEntryInputSchema, UpdateEntryInputSchema } from '@memry/contracts/journal-api'
import {
  ApplyTemplateSchema,
  NoteCreateSchema,
  NoteListSchema,
  NoteUpdateSchema
} from '@memry/contracts/notes-api'
import {
  BulkDismissSchema,
  CreateReminderSchema,
  GetForTargetSchema,
  ListRemindersSchema,
  SnoozeReminderSchema,
  UpdateReminderSchema
} from '@memry/contracts/reminders-api'
import {
  SavedFilterCreateSchema,
  SavedFilterUpdateSchema
} from '@memry/contracts/saved-filters-api'
import { AddReasonSchema, SearchQuerySchema } from '@memry/contracts/search-api'
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
} from '@memry/contracts/settings-schemas'
import {
  GetNotesByTagSchema,
  MergeTagSchema,
  PinNoteToTagSchema,
  RemoveTagFromNoteSchema,
  RenameTagSchema,
  UnpinNoteFromTagSchema,
  UpdateTagColorSchema,
  UpdateTagIconSchema
} from '@memry/contracts/tags-api'
import {
  ProjectCaptureUrlSchema,
  ProjectCreateSchema,
  ProjectImportFilesSchema,
  ProjectLinkItemSchema,
  ProjectSetHomeNoteSchema,
  ProjectSetLinkPinnedSchema,
  ProjectUpdateSchema,
  StatusCreateSchema,
  StatusUpdateSchema,
  TaskCompleteSchema,
  TaskCreateSchema,
  TaskListSchema,
  TaskMoveSchema,
  TaskUpdateSchema
} from '@memry/contracts/tasks-api'
import {
  SetFolderConfigSchema,
  TemplateCreateSchema,
  TemplateUpdateSchema
} from '@memry/contracts/templates-api'
import { UpdateVaultConfigSchema } from '@memry/contracts/vault-api'

import {
  CreatePropertyDefinitionSchema,
  ExportNoteSchema,
  PropertyOptionInputSchema,
  UpdatePropertyDefinitionSchema
} from '../../../ipc/notes-schemas'

/**
 * An input whose handler reads named keys without a schema of its own. Only
 * the key names are known here; the handler still checks the values.
 */
function keysOf(...names: string[]): z.ZodObject {
  return z.object(Object.fromEntries(names.map((name) => [name, z.unknown()])))
}

/**
 * The schema of each object argument an allowlisted operation takes, keyed by
 * the parameter name in `desktopOperationParams`. Each is the schema the IPC
 * handler parses that argument with, so a key it lists is one the handler
 * reads, and any other key would be dropped (or, for settings, stored as is).
 * `desktop-api-inputs.test.ts` finds every object parameter in the preload
 * declaration and checks that each one refuses an unknown key.
 */
export const DESKTOP_INPUT_SCHEMAS: Partial<
  Record<AgentMcpDesktopOperation, Readonly<Record<string, z.ZodType>>>
> = {
  'notes.list': { options: NoteListSchema },
  'notes.create': { input: NoteCreateSchema },
  'notes.update': { input: NoteUpdateSchema },
  'notes.createPropertyDefinition': { input: CreatePropertyDefinitionSchema },
  'notes.updatePropertyDefinition': { input: UpdatePropertyDefinitionSchema },
  'notes.addPropertyOption': { option: PropertyOptionInputSchema },
  'notes.addStatusOption': { option: PropertyOptionInputSchema },
  // The preload reads `name` and calls `arrayBuffer()` on the file.
  'notes.uploadAttachment': { file: keysOf('name', 'arrayBuffer') },
  'notes.setFolderConfig': { config: SetFolderConfigSchema.shape.config },
  'notes.applyTemplate': { input: ApplyTemplateSchema },
  'notes.exportPdf': { input: ExportNoteSchema },
  'notes.exportHtml': { input: ExportNoteSchema },

  'tasks.list': { options: TaskListSchema },
  'tasks.create': { input: TaskCreateSchema },
  'tasks.update': { input: TaskUpdateSchema },
  'tasks.complete': { input: TaskCompleteSchema },
  'tasks.move': { input: TaskMoveSchema },
  'tasks.createProject': { input: ProjectCreateSchema },
  'tasks.updateProject': { input: ProjectUpdateSchema },
  'tasks.linkProjectItem': { input: ProjectLinkItemSchema },
  'tasks.unlinkProjectItem': { input: ProjectLinkItemSchema },
  'tasks.setProjectLinkPinned': { input: ProjectSetLinkPinnedSchema },
  'tasks.setProjectHomeNote': { input: ProjectSetHomeNoteSchema },
  'tasks.captureUrlToProject': { input: ProjectCaptureUrlSchema },
  'tasks.importFilesToProject': { input: ProjectImportFilesSchema },
  'tasks.createStatus': { input: StatusCreateSchema },
  // The preload sends `{ id, ...updates }`.
  'tasks.updateStatus': { updates: StatusUpdateSchema.omit({ id: true }) },

  'inbox.list': { options: InboxListSchema },
  'inbox.getJobs': { options: InboxJobListSchema },
  'inbox.listArchived': { options: ListArchivedSchema },
  'inbox.getFilingHistory': { options: GetFilingHistorySchema },
  'inbox.captureText': { input: CaptureTextSchema },
  'inbox.captureLink': { input: CaptureLinkSchema },
  'inbox.captureImage': { input: CaptureImageSchema },
  'inbox.captureVoice': { input: CaptureVoiceSchema },
  'inbox.captureClip': { input: CaptureClipSchema },
  'inbox.capturePdf': { input: CapturePdfSchema },
  'inbox.update': { input: InboxUpdateSchema },
  'inbox.file': { input: FileItemSchema },
  'inbox.trackSuggestion': {
    input: keysOf(
      'itemId',
      'itemType',
      'suggestedTo',
      'actualTo',
      'confidence',
      'suggestedTags',
      'actualTags'
    )
  },
  'inbox.convertToTask': { input: keysOf('projectId', 'dueDate', 'dueTime', 'priority') },
  'inbox.convertToEvent': { input: keysOf('startAt', 'endAt', 'isAllDay', 'location') },
  'inbox.convertToReminder': { input: keysOf('remindAt') },
  'inbox.snooze': { input: SnoozeSchema },
  'inbox.bulkFile': { input: BulkFileSchema },
  'inbox.bulkArchive': { input: BulkArchiveSchema },
  'inbox.bulkTag': { input: BulkTagSchema },
  'inbox.bulkSnooze': { input: keysOf('itemIds', 'snoozeUntil', 'reason') },

  'journal.createEntry': { input: CreateEntryInputSchema },
  'journal.updateEntry': { input: UpdateEntryInputSchema },
  // An open record: every key is a property name.
  'properties.set': { properties: z.record(z.string(), z.unknown()) },

  'templates.create': { input: TemplateCreateSchema },
  'templates.update': { input: TemplateUpdateSchema },
  'savedFilters.create': { input: SavedFilterCreateSchema },
  'savedFilters.update': { input: SavedFilterUpdateSchema },

  'bookmarks.list': { options: BookmarkListSchema },
  'bookmarks.isBookmarked': { input: BookmarkCheckSchema },
  'bookmarks.getByItem': { input: BookmarkCheckSchema },
  'bookmarks.create': { input: BookmarkCreateSchema },
  'bookmarks.toggle': { input: BookmarkToggleSchema },
  'bookmarks.bulkCreate': { items: BookmarkBulkCreateSchema.shape.items },

  'tags.getNotesByTag': { input: GetNotesByTagSchema },
  'tags.pinNoteToTag': { input: PinNoteToTagSchema },
  'tags.unpinNoteFromTag': { input: UnpinNoteFromTagSchema },
  'tags.renameTag': { input: RenameTagSchema },
  'tags.updateTagColor': { input: UpdateTagColorSchema },
  'tags.removeTagFromNote': { input: RemoveTagFromNoteSchema },
  'tags.mergeTag': { input: MergeTagSchema },
  'tags.updateTagIcon': { input: UpdateTagIconSchema },
  'tags.createCategory': { input: keysOf('name') },
  'tags.renameCategory': { input: keysOf('id', 'name') },
  'tags.deleteCategory': { input: keysOf('id') },
  'tags.reorder': {
    input: z.object({
      tags: z.array(keysOf('tag', 'categoryId', 'sortOrder')).optional(),
      categories: z.array(keysOf('id', 'sortOrder')).optional()
    })
  },

  'folderView.getViews': { scope: GetViewsRequestSchema.shape.scope },
  'folderView.listWithProperties': { options: ListWithPropertiesRequestSchema },
  'folderView.getAvailableProperties': { scope: GetAvailablePropertiesRequestSchema.shape.scope },
  'folderView.setConfig': { config: SetConfigRequestSchema.shape.config },
  'folderView.setView': {
    scope: SetViewRequestSchema.shape.scope,
    view: SetViewRequestSchema.shape.view
  },
  'folderView.deleteView': { scope: DeleteViewRequestSchema.shape.scope },

  'reminders.list': { options: ListRemindersSchema },
  'reminders.getForTarget': { input: GetForTargetSchema },
  'reminders.create': { input: CreateReminderSchema },
  'reminders.update': { input: UpdateReminderSchema },
  'reminders.snooze': { input: SnoozeReminderSchema },
  'reminders.bulkDismiss': { input: BulkDismissSchema },

  'calendar.listEvents': { options: ListCalendarEventsSchema },
  // The responder reads only these four and fills the rest from stored consent.
  'calendar.getRange': { inputOrStart: keysOf('startAt', 'endAt', 'start', 'end') },
  'calendar.createEvent': { input: CreateCalendarEventSchema },
  'calendar.updateEvent': { input: UpdateCalendarEventSchema },

  'settings.setJournalSettings': {
    settings: keysOf(
      'defaultTemplate',
      'weekdayTemplates',
      'showSchedule',
      'showTasks',
      'showAIConnections',
      'showStatsFooter'
    )
  },
  'settings.setAISettings': { settings: keysOf('enabled') },
  'settings.setVoiceTranscriptionSettings': { settings: VoiceTranscriptionSettingsSchema },
  'settings.setTabSettings': { settings: keysOf('restoreSessionOnStart', 'tabCloseButton') },
  'settings.setNoteEditorSettings': { settings: keysOf('toolbarMode') },
  'settings.setGeneralSettings': { settings: GeneralSettingsSchema },
  'settings.setEditorSettings': { settings: EditorSettingsSchema },
  'settings.setTaskSettings': { settings: TaskSettingsSchema },
  'settings.setKeyboardSettings': { settings: KeyboardShortcutsSchema },
  'settings.setSyncSettings': { settings: SyncSettingsSchema },
  'settings.setBackupSettings': { settings: BackupSettingsSchema },
  'settings.setGraphSettings': { settings: GraphSettingsSchema },
  'settings.setCalendarSettings': { settings: CalendarSettingsSchema },
  'settings.setFeaturesSettings': { settings: FeaturesSettingsSchema },
  'settings.setInboxSettings': { settings: InboxSettingsSchema },

  'search.query': { params: SearchQuerySchema },
  'search.addReason': { params: AddReasonSchema },
  'graph.getLocal': { params: LocalGraphRequestSchema },
  'homePages.create': { input: HomePageCreateSchema },
  'homePages.update': { input: HomePageUpdateSchema },
  'vault.updateConfig': { config: UpdateVaultConfigSchema },
  'canvas.create': { input: CanvasCreateSchema }
}
