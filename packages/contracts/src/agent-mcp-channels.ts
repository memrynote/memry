import { z } from 'zod'

// .ts extension required: this file is read by the rpc bindings generator under
// node --experimental-strip-types (same constraint as canvas-api.ts).
import { CanvasEntityRefSchema } from './canvas-api.ts'

export const AgentMcpChannels = {
  invoke: {
    GET_STATUS: 'agent_mcp:get_status',
    ['ROTATE_TOKEN']: 'agent_mcp:rotate_token'
  }
} as const

export const AgentMcpDesktopApiChannel = 'agent_mcp:desktop_api'

export const AgentMcpDesktopReadOperations = [
  'notes.get',
  'notes.getByPath',
  'notes.getFile',
  'notes.resolveByTitle',
  'notes.previewByTitle',
  'notes.list',
  'notes.getTags',
  'notes.getLinks',
  'notes.getFolders',
  'notes.exists',
  'notes.getPropertyDefinitions',
  'notes.listAttachments',
  'notes.getFolderConfig',
  'notes.getFolderTemplate',
  'notes.getVersions',
  'notes.getVersion',
  'notes.getPositions',
  'notes.getAllPositions',
  'notes.getLocalOnlyCount',
  'notes.getCalendarPropertyNames',
  'tasks.get',
  'tasks.list',
  'tasks.getSubtasks',
  'tasks.getProject',
  'tasks.listProjects',
  'tasks.listStatuses',
  'tasks.getTags',
  'tasks.getStats',
  'tasks.getToday',
  'tasks.getUpcoming',
  'tasks.getOverdue',
  'tasks.getLinkedTasks',
  'tasks.listProjectLinks',
  'tasks.listProjectContents',
  'tasks.listForItem',
  'inbox.get',
  'inbox.list',
  'inbox.previewLink',
  'inbox.getSuggestions',
  'inbox.getTags',
  'inbox.getSnoozed',
  'inbox.getStats',
  'inbox.getJobs',
  'inbox.getPatterns',
  'inbox.getStaleThreshold',
  'inbox.listArchived',
  'inbox.getFilingHistory',
  'journal.getEntry',
  'journal.getHeatmap',
  'journal.getMonthEntries',
  'journal.getYearStats',
  'journal.getDayContext',
  'journal.getAllTags',
  'journal.getStreak',
  'properties.get',
  'templates.list',
  'templates.get',
  'savedFilters.list',
  'bookmarks.get',
  'bookmarks.list',
  'bookmarks.isBookmarked',
  'bookmarks.listByType',
  'bookmarks.getByItem',
  'tags.getNotesByTag',
  'tags.getAllWithCounts',
  'folderView.getConfig',
  'folderView.getViews',
  'folderView.listWithProperties',
  'folderView.getAvailableProperties',
  'folderView.getFolderSuggestions',
  'folderView.folderExists',
  'reminders.get',
  'reminders.list',
  'reminders.getUpcoming',
  'reminders.getDue',
  'reminders.getForTarget',
  'reminders.countPending',
  // Google Workspace Limited Use: agent backends may only see native memrynote
  // calendar data. Google-integration operations (sources, provider status,
  // Google calendar lists, Google settings) must stay out of both allowlists.
  'calendar.getEvent',
  'calendar.listEvents',
  'calendar.getRange',
  'settings.get',
  'settings.getJournalSettings',
  'settings.getAISettings',
  'settings.getVoiceTranscriptionSettings',
  'settings.getVoiceModelStatus',
  'settings.getVoiceRecordingReadiness',
  'settings.getVoiceTranscriptionOpenAIKeyStatus',
  'settings.getAIModelStatus',
  'settings.getTabSettings',
  'settings.getNoteEditorSettings',
  'settings.getGeneralSettings',
  'settings.getEditorSettings',
  'settings.getTaskSettings',
  'settings.getKeyboardSettings',
  'settings.getSyncSettings',
  'settings.getBackupSettings',
  'settings.getGraphSettings',
  'settings.getCalendarSettings',
  'settings.getFeaturesSettings',
  'settings.getInboxSettings',
  'search.query',
  'search.quick',
  'search.getStats',
  'search.getReasons',
  'search.getAllTags',
  'graph.getData',
  'graph.getLocal',
  'homePages.list',
  'homePages.get',
  'vault.getAll',
  'vault.getStatus',
  'vault.getConfig',
  'vault.listAccount',
  // Canvas (#916). canvas.get is deliberately absent — it returns the whole
  // serialized scene, which is the geometry dump vault_read_canvas exists to
  // avoid. See docs/superpowers/specs/2026-08-03-mcp-canvas-coverage-design.md §3.2.
  'canvas.list',
  'canvas.getAsset',
  'canvas.listAssets',
  'canvas.libraryList'
] as const

export const AgentMcpDesktopWriteOperations = [
  'notes.create',
  'notes.update',
  'notes.rename',
  'notes.move',
  'notes.delete',
  'notes.createFolder',
  'notes.renameFolder',
  'notes.deleteFolder',
  'notes.createPropertyDefinition',
  'notes.updatePropertyDefinition',
  'notes.ensurePropertyDefinition',
  'notes.addPropertyOption',
  'notes.addStatusOption',
  'notes.removePropertyOption',
  'notes.renamePropertyOption',
  'notes.updateOptionColor',
  'notes.deletePropertyDefinition',
  'notes.uploadAttachment',
  'notes.deleteAttachment',
  'notes.setFolderConfig',
  'notes.restoreVersion',
  'notes.deleteVersion',
  'notes.reorder',
  'notes.importFiles',
  'notes.setLocalOnly',
  'notes.setCalendarPropertyVisibility',
  'notes.applyTemplate',
  'notes.exportPdf',
  'notes.exportHtml',
  'tasks.create',
  'tasks.update',
  'tasks.delete',
  'tasks.complete',
  'tasks.uncomplete',
  'tasks.archive',
  'tasks.unarchive',
  'tasks.move',
  'tasks.reorder',
  'tasks.duplicate',
  'tasks.convertToSubtask',
  'tasks.convertToTask',
  'tasks.createProject',
  'tasks.updateProject',
  'tasks.deleteProject',
  'tasks.archiveProject',
  'tasks.reorderProjects',
  'tasks.linkProjectItem',
  'tasks.unlinkProjectItem',
  'tasks.setProjectLinkPinned',
  'tasks.setProjectHomeNote',
  // These two reach the network and the filesystem, but on caller-supplied
  // input only — the same footing as the allowlisted `inbox.captureLink` and
  // `notes.importFiles`. What stays out is opening native UI or handing an
  // item to the OS (`notes.showImportDialog`, `notes.openExternal`,
  // `notes.revealInFinder`).
  'tasks.captureUrlToProject',
  'tasks.importFilesToProject',
  'tasks.createStatus',
  'tasks.updateStatus',
  'tasks.deleteStatus',
  'tasks.reorderStatuses',
  'tasks.bulkComplete',
  'tasks.bulkDelete',
  'tasks.bulkMove',
  'tasks.bulkArchive',
  'inbox.captureText',
  'inbox.captureLink',
  'inbox.captureImage',
  'inbox.captureVoice',
  'inbox.captureClip',
  'inbox.capturePdf',
  'inbox.update',
  'inbox.archive',
  'inbox.file',
  'inbox.trackSuggestion',
  'inbox.convertToNote',
  'inbox.convertToTask',
  'inbox.convertToEvent',
  'inbox.convertToReminder',
  'inbox.linkToNote',
  'inbox.addTag',
  'inbox.removeTag',
  'inbox.snooze',
  'inbox.unsnooze',
  'inbox.markViewed',
  'inbox.bulkFile',
  'inbox.bulkArchive',
  'inbox.bulkTag',
  'inbox.bulkSnooze',
  'inbox.fileAllStale',
  'inbox.retryTranscription',
  'inbox.retryMetadata',
  'inbox.setStaleThreshold',
  'inbox.unarchive',
  'inbox.deletePermanent',
  'inbox.undoFile',
  'inbox.undoArchive',
  'journal.createEntry',
  'journal.updateEntry',
  'journal.deleteEntry',
  'properties.set',
  'properties.rename',
  'templates.create',
  'templates.update',
  'templates.delete',
  'templates.duplicate',
  'savedFilters.create',
  'savedFilters.update',
  'savedFilters.delete',
  'savedFilters.reorder',
  'bookmarks.create',
  'bookmarks.delete',
  'bookmarks.toggle',
  'bookmarks.reorder',
  'bookmarks.bulkDelete',
  'bookmarks.bulkCreate',
  'tags.pinNoteToTag',
  'tags.unpinNoteFromTag',
  'tags.renameTag',
  'tags.updateTagColor',
  'tags.deleteTag',
  'tags.removeTagFromNote',
  'tags.mergeTag',
  'tags.updateTagIcon',
  'folderView.setConfig',
  'folderView.setView',
  'folderView.deleteView',
  'reminders.create',
  'reminders.update',
  'reminders.delete',
  'reminders.dismiss',
  'reminders.snooze',
  'reminders.bulkDismiss',
  'calendar.createEvent',
  'calendar.updateEvent',
  'calendar.deleteEvent',
  'settings.set',
  'settings.setJournalSettings',
  'settings.setAISettings',
  'settings.setVoiceTranscriptionSettings',
  'settings.setTabSettings',
  'settings.setNoteEditorSettings',
  'settings.setGeneralSettings',
  'settings.setEditorSettings',
  'settings.setTaskSettings',
  'settings.setKeyboardSettings',
  'settings.resetKeyboardSettings',
  'settings.setSyncSettings',
  'settings.setBackupSettings',
  'settings.setGraphSettings',
  'settings.setCalendarSettings',
  'settings.setFeaturesSettings',
  'settings.setInboxSettings',
  'search.rebuildIndex',
  'search.addReason',
  'search.clearReasons',
  'homePages.create',
  'homePages.update',
  'homePages.delete',
  'homePages.reorder',
  'vault.switch',
  'vault.reindex',
  'vault.updateConfig',
  'vault.downloadRemote',
  // Canvas (#916). Whole-canvas lifecycle only. canvas.update (blind
  // whole-scene clobber of an open editor), canvas.librarySave (a partial list
  // deletes the user's shape library) and canvas.uploadAsset (binary payload)
  // stay out; item add/remove goes through the dedicated canvas item tools.
  'canvas.create',
  'canvas.delete'
] as const

export const AgentMcpDesktopOperations = [
  ...AgentMcpDesktopReadOperations,
  ...AgentMcpDesktopWriteOperations
] as const

export type AgentMcpDesktopReadOperation = (typeof AgentMcpDesktopReadOperations)[number]
export type AgentMcpDesktopWriteOperation = (typeof AgentMcpDesktopWriteOperations)[number]
export type AgentMcpDesktopOperation = (typeof AgentMcpDesktopOperations)[number]

export function isAgentMcpDesktopOperation(value: string): value is AgentMcpDesktopOperation {
  return (AgentMcpDesktopOperations as readonly string[]).includes(value)
}

export const AgentMcpDesktopApiRequestSchema = z.object({
  operation: z.enum(AgentMcpDesktopOperations),
  args: z.array(z.unknown()).default([])
})

export type AgentMcpDesktopApiRequest = z.infer<typeof AgentMcpDesktopApiRequestSchema>

export type AgentMcpDesktopApiResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } }

// ============================================================================
// Canvas item writes (#916)
// ============================================================================

/**
 * Main→renderer channel for agent canvas item writes. Writes go through a
 * renderer because convertToExcalidrawElements — the only thing that correctly
 * mints element ids, seeds, version counters and fractional indices — exists
 * only there. The renderer applies to the live Excalidraw instance when it has
 * that canvas open, and otherwise does a guarded headless read-modify-write.
 */
export const AgentMcpCanvasWriteChannel = 'agent_mcp:canvas_write'

export const AgentMcpCanvasWriteRequestSchema = z.object({
  canvasId: z.string().min(1),
  op: z.enum(['add', 'remove']),
  items: z.array(CanvasEntityRefSchema).min(1).max(20)
})
export type AgentMcpCanvasWriteRequest = z.infer<typeof AgentMcpCanvasWriteRequestSchema>

export interface AgentMcpCanvasWriteSkip {
  ref: { entityType: string; entityId: string }
  reason: 'already-on-canvas' | 'not-on-canvas'
}

export type AgentMcpCanvasWriteResponse =
  | {
      ok: true
      applied: { entityType: string; entityId: string }[]
      skipped: AgentMcpCanvasWriteSkip[]
      updatedAt: number
      /** Saved locally but too large to sync (canvas spec §5.6). */
      tooLarge: boolean
      /** Which route ran — 'live' means the user has that canvas open. */
      path: 'live' | 'headless'
    }
  | { ok: false; error: { code: string; message: string } }

export const AgentMcpStatusSchema = z.object({
  url: z.string().nullable(),
  ['token']: z.string().nullable(),
  toolCount: z.number().int().nonnegative()
})

export type AgentMcpStatus = z.infer<typeof AgentMcpStatusSchema>
