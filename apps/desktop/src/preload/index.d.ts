import { ElectronAPI } from '@electron-toolkit/preload'
import type { GeneratedRpcApi } from '@memry/rpc'
import type * as InboxRpc from '@memry/rpc/inbox'
import type * as NotesRpc from '@memry/rpc/notes'
import type * as TasksRpc from '@memry/rpc/tasks'
import type { AppNavigationCommandEvent, AppMenuCommandEvent } from '@memry/contracts/ipc-channels'
import type { AgentMcpStatus } from '@memry/contracts/agent-mcp-channels'
import type {
  AgentEvent,
  AgentBackendId,
  AgentBackendModelList,
  AgentBackendModelListRequest,
  AgentLocalModelList,
  AgentLocalProviderProbeResult,
  AgentLocalProviderSettings,
  AgentLocalProviderSettingsUpdate,
  AgentPreferences,
  AgentPreferencesUpdate,
  ApproveToolRequest,
  BackendStatusesResponse,
  PreviewDiffRequest,
  PreviewDiffResponse,
  SendTurnRequest,
  SendTurnResponse,
  Conversation,
  Message
} from '@memry/contracts/ipc-agent'
import type { AppUpdateState } from '@memry/contracts/ipc-updater'
import type {
  ImportStartInput,
  ImportStartResponse,
  ImportCancelInput,
  ImportPickFilesInput,
  ImportPickFilesResult,
  ImportProgressEvent,
  ImportPreviewInput,
  ImportPreviewResponse,
  ImporterMeta
} from '@memry/contracts/import-channels'
import type { Locale, LocaleApi } from '@memry/contracts/locale-api'
import type {
  SyncStatusChangedEvent,
  ItemSyncedEvent,
  ConflictDetectedEvent,
  LinkingRequestEvent,
  LinkingApprovedEvent,
  LinkingFinalizedEvent,
  UploadProgressEvent,
  AttachmentUploadFailedEvent,
  DownloadProgressEvent,
  InitialSyncProgressEvent,
  QueueClearedEvent,
  SyncPausedEvent,
  SyncResumedEvent,
  SessionExpiredEvent,
  OtpDetectedEvent,
  OAuthCallbackEvent,
  OAuthErrorEvent,
  ClockSkewWarningEvent,
  DeviceRevokedEvent,
  SecurityWarningEvent,
  CertificatePinFailedEvent,
  VaultRecoveryNeededEvent
} from '../shared/contracts/ipc-sync'
import type { CrdtOpenDocResult, CrdtSyncStep1Result } from '@memry/contracts/ipc-crdt'
import type {
  FolderViewClientAPI as ContractFolderViewClientAPI,
  ConfigUpdatedEvent as FolderViewConfigUpdatedEvent
} from '@memry/contracts/folder-view-api'
import type { ResolvedRelationRef } from '@memry/contracts/properties-api'

// Vault types (mirrored from contracts for preload compatibility)
export interface VaultInfo {
  path: string
  name: string
  noteCount: number
  taskCount: number
  lastOpened: string
  isDefault: boolean
  vaultUuid?: string
}

export type NoteFrontmatter = NotesRpc.Note['frontmatter']
export type Note = NotesRpc.Note

export type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'status'
  | 'url'
  | 'rating'
  | 'relation'

export interface PropertyValue {
  name: string
  value: unknown
  type: PropertyType
}

export type PropertyDefinition = NotesRpc.PropertyDefinition
export type CreatePropertyDefinitionInput = NotesRpc.CreatePropertyDefinitionInput
export type UpdatePropertyDefinitionInput = NotesRpc.UpdatePropertyDefinitionInput

export interface SetPropertiesResponse {
  success: boolean
  error?: string
}

export type CreatePropertyDefinitionResponse = NotesRpc.CreatePropertyDefinitionResponse

export type AttachmentResult = NotesRpc.AttachmentResult
export type AttachmentInfo = NotesRpc.AttachmentInfo
export type DeleteAttachmentResponse = NotesRpc.DeleteAttachmentResponse

// Template types (Phase 15)
export type TemplatePropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'rating'
  | 'project'

export interface TemplateProperty {
  name: string
  type: TemplatePropertyType
  value: unknown
  options?: string[]
}

export interface Template {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
  tags: string[]
  properties: TemplateProperty[]
  content: string
  createdAt: string
  modifiedAt: string
}

export interface TemplateListItem {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
}

export interface TemplateCreateInput {
  name: string
  description?: string
  icon?: string | null
  tags?: string[]
  properties?: TemplateProperty[]
  content?: string
}

export interface TemplateUpdateInput {
  id: string
  name?: string
  description?: string
  icon?: string | null
  tags?: string[]
  properties?: TemplateProperty[]
  content?: string
}

export interface TemplateCreateResponse {
  success: boolean
  template: Template | null
  error?: string
}

export interface TemplateListResponse {
  templates: TemplateListItem[]
}

export type FolderConfig = NotesRpc.FolderConfig
export type FolderInfo = NotesRpc.FolderInfo

export type ExportNoteInput = NotesRpc.ExportNoteInput
export type ExportNoteResponse = NotesRpc.ExportNoteResponse

export type SnapshotReason = NotesRpc.SnapshotListItem['reason']
export type SnapshotListItem = NotesRpc.SnapshotListItem
export type SnapshotDetail = NotesRpc.SnapshotDetail
export type RestoreVersionResponse = NotesRpc.RestoreVersionResponse

export interface TemplateCreatedEvent {
  template: Template
}

export interface TemplateUpdatedEvent {
  id: string
  template: Template
}

export interface TemplateDeletedEvent {
  id: string
}

export type NoteListItem = NotesRpc.NoteListItem
export type FileMetadata = NotesRpc.FileMetadata
export type WikiLinkResolution = NotesRpc.WikiLinkResolution
export type WikiLinkPreview = NotesRpc.WikiLinkPreview
export type NoteCreateInput = NotesRpc.NoteCreateInput
export type NoteUpdateInput = NotesRpc.NoteUpdateInput
export type NoteListOptions = NotesRpc.NoteListOptions
export type NoteCreateResponse = NotesRpc.NoteCreateResponse
export type NoteUpdateResponse = NotesRpc.NoteUpdateResponse
export type NoteListResponse = NotesRpc.NoteListResponse
export type NoteLink = NotesRpc.NoteLink
export type BacklinkContext = NotesRpc.BacklinkContext
export type Backlink = NotesRpc.Backlink
export type NoteLinksResponse = NotesRpc.NoteLinksResponse
export type NoteCreatedEvent = NotesRpc.NoteCreatedEvent
export type NoteUpdatedEvent = NotesRpc.NoteUpdatedEvent
export type NoteDeletedEvent = NotesRpc.NoteDeletedEvent
export type NoteRenamedEvent = NotesRpc.NoteRenamedEvent
export type NoteMovedEvent = NotesRpc.NoteMovedEvent
export type NoteExternalChangeEvent = NotesRpc.NoteExternalChangeEvent

export interface IndexRecoveredEvent {
  reason: 'corrupt' | 'missing' | 'healthy'
  filesIndexed: number
  duration: number
}

export type RepeatConfig = TasksRpc.RepeatConfig

export type Task = TasksRpc.Task
export type TaskListItem = TasksRpc.TaskListItem
export type Project = TasksRpc.Project
export type ProjectWithStats = TasksRpc.ProjectWithStats
export type ProjectWithStatuses = TasksRpc.ProjectWithStatuses
export type Status = TasksRpc.Status
export type TaskCreateInput = TasksRpc.TaskCreateInput
export type TaskUpdateInput = TasksRpc.TaskUpdateInput
export type TaskListOptions = TasksRpc.TaskListOptions
export type TaskCreateResponse = TasksRpc.TaskCreateResponse
export type TaskListResponse = TasksRpc.TaskListResponse
export type ProjectCreateInput = TasksRpc.ProjectCreateInput
export type ProjectUpdateInput = TasksRpc.ProjectUpdateInput
export type ProjectListResponse = TasksRpc.ProjectListResponse
export type StatusCreateInput = TasksRpc.StatusCreateInput
export type TaskStats = TasksRpc.TaskStats
export type TaskMoveInput = TasksRpc.TaskMoveInput
export type TaskCreatedEvent = TasksRpc.TaskCreatedEvent
export type TaskUpdatedEvent = TasksRpc.TaskUpdatedEvent
export type TaskDeletedEvent = TasksRpc.TaskDeletedEvent
export type TaskCompletedEvent = TasksRpc.TaskCompletedEvent
export type TaskMovedEvent = TasksRpc.TaskMovedEvent
export type ProjectCreatedEvent = TasksRpc.ProjectCreatedEvent
export type ProjectUpdatedEvent = TasksRpc.ProjectUpdatedEvent
export type ProjectDeletedEvent = TasksRpc.ProjectDeletedEvent

// Saved Filter types
export interface DueDateFilter {
  type:
    | 'any'
    | 'none'
    | 'overdue'
    | 'today'
    | 'tomorrow'
    | 'this-week'
    | 'next-week'
    | 'this-month'
    | 'custom'
  customStart?: string | null
  customEnd?: string | null
}

export interface TaskFiltersConfig {
  search: string
  projectIds: string[]
  priorities: Array<'urgent' | 'high' | 'medium' | 'low' | 'none'>
  tags: string[]
  dueDate: DueDateFilter
  statusIds: string[]
  completion: 'active' | 'completed' | 'all'
  repeatType: 'all' | 'repeating' | 'one-time'
  hasTime: 'all' | 'with-time' | 'without-time'
}

export interface TaskSortConfig {
  field: 'dueDate' | 'priority' | 'status' | 'createdAt' | 'title' | 'project' | 'completedAt'
  direction: 'asc' | 'desc'
}

export interface SavedFilterConfig {
  filters: TaskFiltersConfig
  sort?: TaskSortConfig
}

export interface SavedFilter {
  id: string
  name: string
  config: SavedFilterConfig
  position: number
  createdAt: string
}

export interface SavedFilterCreateInput {
  name: string
  config: SavedFilterConfig
}

export interface SavedFilterUpdateInput {
  id: string
  name?: string
  config?: SavedFilterConfig
  position?: number
}

export interface SavedFilterListResponse {
  savedFilters: SavedFilter[]
}

export interface SavedFilterCreateResponse {
  success: boolean
  savedFilter: SavedFilter | null
  error?: string
}

export interface SavedFilterUpdatedEvent {
  id: string
  savedFilter: SavedFilter
}

export interface SavedFilterCreatedEvent {
  savedFilter: SavedFilter
}

export interface SavedFilterDeletedEvent {
  id: string
}

// Journal types (mirrored from contracts for preload compatibility)
export type ActivityLevel = 0 | 1 | 2 | 3 | 4

export interface JournalEntry {
  id: string
  date: string
  content: string
  wordCount: number
  characterCount: number
  tags: string[]
  properties?: Record<string, unknown>
  createdAt: string
  modifiedAt: string
}

export interface HeatmapEntry {
  date: string
  characterCount: number
  level: ActivityLevel
}

export interface MonthEntryPreview {
  date: string
  preview: string
  wordCount: number
  characterCount: number
  activityLevel: ActivityLevel
  tags: string[]
}

export interface MonthStats {
  year: number
  month: number
  entryCount: number
  totalWordCount: number
  totalCharacterCount: number
  averageLevel: number
}

export interface DayTask {
  id: string
  title: string
  completed: boolean
  priority?: 'low' | 'medium' | 'high' | 'urgent'
  isOverdue?: boolean
}

export interface ScheduleEvent {
  id: string
  time: string
  title: string
  type: 'meeting' | 'focus' | 'event'
  attendeeCount?: number
}

export interface DayContext {
  date: string
  tasks: DayTask[]
  events: ScheduleEvent[]
  overdueCount: number
}

export interface JournalStreak {
  currentStreak: number
  longestStreak: number
  lastEntryDate: string | null
}

export interface JournalTagCount {
  tag: string
  count: number
}

export interface JournalEntryCreatedEvent {
  date: string
  entry: JournalEntry
}

export interface JournalEntryUpdatedEvent {
  date: string
  entry: JournalEntry
}

export interface JournalEntryDeletedEvent {
  date: string
}

export interface JournalExternalChangeEvent {
  date: string
  type: 'modified' | 'deleted'
}

export interface VaultStatus {
  isOpen: boolean
  path: string | null
  isIndexing: boolean
  indexProgress: number
  error: string | null
}

export interface VaultConfig {
  excludePatterns: string[]
  defaultNoteFolder: string
  journalFolder: string
  journalDateFormat: string
  attachmentsFolder: string
}

export interface SelectVaultResponse {
  success: boolean
  vault: VaultInfo | null
  error?: string
}

export interface GetVaultsResponse {
  vaults: VaultInfo[]
  currentVault: string | null
}

export interface AccountVaultInfo {
  vaultUuid: string
  name: string | null
  itemCount: number
  createdAt: number | null
  localPath: string | null
  suggestedPath: string
}

// Vault client API interface
export interface VaultClientAPI {
  select(path?: string): Promise<SelectVaultResponse>
  create(path: string, name: string): Promise<SelectVaultResponse>
  getAll(): Promise<GetVaultsResponse>
  getStatus(): Promise<VaultStatus>
  getConfig(): Promise<VaultConfig>
  updateConfig(config: Partial<VaultConfig>): Promise<VaultConfig>
  close(): Promise<void>
  switch(vaultPath: string): Promise<SelectVaultResponse>
  remove(vaultPath: string): Promise<void>
  reindex(): Promise<void>
  reveal(): Promise<void>
  listAccount(): Promise<AccountVaultInfo[]>
  downloadRemote(vaultUuid: string, parentPath?: string): Promise<SelectVaultResponse>
  deleteFromAccount(vaultUuid: string): Promise<void>
  resolveEmbeds(input: { refs: string[]; notePath?: string }): Promise<Record<string, string>>
}

// Notes client API interface
export type NotesClientAPI = NotesRpc.NotesClientAPI

// Unified Properties API (works with notes and journal entries)
export interface PropertiesClientAPI {
  /**
   * Get properties for any entity (note or journal entry) by ID.
   */
  get(entityId: string): Promise<PropertyValue[]>
  /**
   * Set properties for any entity (note or journal entry) by ID.
   */
  set(entityId: string, properties: Record<string, unknown>): Promise<SetPropertiesResponse>
  /**
   * Rename a property for a specific entity (note-only scope).
   * Does not propagate to other entities - only affects this entity's frontmatter.
   */
  rename(
    entityId: string,
    oldName: string,
    newName: string
  ): Promise<{ success: true } | { success: false; error: string }>
  /**
   * Resolve relation property URIs (memry://<kind>/<id>) to display data.
   * Preserves the input array's order and length; never throws.
   */
  resolveRefs(uris: string[]): Promise<ResolvedRelationRef[]>
}

// Tasks client API interface
export type TasksClientAPI = TasksRpc.TasksClientAPI

// Saved Filters client API interface
export interface SavedFiltersClientAPI {
  list(): Promise<SavedFilterListResponse>
  create(input: SavedFilterCreateInput): Promise<SavedFilterCreateResponse>
  update(input: SavedFilterUpdateInput): Promise<SavedFilterCreateResponse>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  reorder(ids: string[], positions: number[]): Promise<{ success: boolean; error?: string }>
}

// Templates client API interface
export interface TemplatesClientAPI {
  list(): Promise<TemplateListResponse>
  get(id: string): Promise<Template | null>
  create(input: TemplateCreateInput): Promise<TemplateCreateResponse>
  update(input: TemplateUpdateInput): Promise<TemplateCreateResponse>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  duplicate(id: string, newName: string): Promise<TemplateCreateResponse>
}

// Journal client API interface
export interface JournalClientAPI {
  // Entry CRUD
  getEntry(date: string): Promise<JournalEntry | null>
  createEntry(input: {
    date: string
    content?: string
    tags?: string[]
    properties?: Record<string, unknown>
  }): Promise<JournalEntry>
  updateEntry(input: {
    date: string
    content?: string
    tags?: string[]
    properties?: Record<string, unknown>
  }): Promise<JournalEntry>
  deleteEntry(date: string): Promise<{ success: boolean }>

  // Calendar & Views
  getHeatmap(year: number): Promise<HeatmapEntry[]>
  getMonthEntries(year: number, month: number): Promise<MonthEntryPreview[]>
  getYearStats(year: number): Promise<MonthStats[]>

  // Context
  getDayContext(date: string): Promise<DayContext>

  // Tags
  getAllTags(): Promise<JournalTagCount[]>

  // Streak
  getStreak(): Promise<JournalStreak>
}

// Home Page types
export interface WidgetInstance {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  config: Record<string, unknown>
}

export interface HomePage {
  id: string
  name: string
  icon?: string
  position: number
  widgets: WidgetInstance[]
}

export interface HomePagesClientAPI {
  list(): Promise<HomePage[]>
  get(id: string): Promise<HomePage | null>
  create(input: {
    name: string
    icon?: string
    position?: number
    widgets?: WidgetInstance[]
  }): Promise<HomePage>
  update(input: {
    id: string
    name?: string
    icon?: string
    position?: number
    widgets?: WidgetInstance[]
  }): Promise<HomePage>
  delete(id: string): Promise<{ success: boolean }>
  reorder(ids: string[]): Promise<{ success: boolean }>
}

// Bookmark types
export interface Bookmark {
  id: string
  itemType: string
  itemId: string
  position: number
  createdAt: string
}

export interface BookmarkItemMeta {
  path?: string
  emoji?: string
  tags?: string[]
}

export interface BookmarkWithItem extends Bookmark {
  itemTitle: string | null
  itemExists: boolean
  itemMeta?: BookmarkItemMeta
}

export interface BookmarkListOptions {
  itemType?: string
  sortBy?: 'position' | 'createdAt'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface BookmarkCreateResponse {
  success: boolean
  bookmark: Bookmark | null
  error?: string
}

export interface BookmarkToggleResponse {
  success: boolean
  isBookmarked: boolean
  bookmark: Bookmark | null
  error?: string
}

export interface BookmarkListResponse {
  bookmarks: BookmarkWithItem[]
  total: number
  hasMore: boolean
}

export interface BookmarkDeleteResponse {
  success: boolean
  error?: string
}

/**
 * Bookmark events have two producers with different payload shapes:
 * the local IPC handlers (main/ipc/bookmarks-handlers.ts) send the resolved
 * row, while the sync handler (main/sync/item-handlers/bookmark-handler.ts)
 * has no resolved row for an inbound change and sends only `{ id }`.
 * Consumers must tolerate both.
 */
export interface BookmarkCreatedEvent {
  bookmark?: Bookmark
  id?: string
}

export interface BookmarkUpdatedEvent {
  id: string
}

export interface BookmarkDeletedEvent {
  id: string
  itemType?: string
  itemId?: string
}

export interface BookmarksReorderedEvent {
  bookmarkIds: string[]
}

// Bookmarks client API interface
export interface BookmarksClientAPI {
  create(input: { itemType: string; itemId: string }): Promise<BookmarkCreateResponse>
  delete(id: string): Promise<BookmarkDeleteResponse>
  get(id: string): Promise<Bookmark | null>
  list(options?: BookmarkListOptions): Promise<BookmarkListResponse>
  isBookmarked(input: { itemType: string; itemId: string }): Promise<boolean>
  toggle(input: { itemType: string; itemId: string }): Promise<BookmarkToggleResponse>
  reorder(bookmarkIds: string[]): Promise<{ success: boolean; error?: string }>
  listByType(itemType: string): Promise<BookmarkListResponse>
  getByItem(input: { itemType: string; itemId: string }): Promise<Bookmark | null>
  bulkDelete(
    bookmarkIds: string[]
  ): Promise<{ success: boolean; deletedCount: number; error?: string }>
  bulkCreate(
    items: Array<{ itemType: string; itemId: string }>
  ): Promise<{ success: boolean; createdCount: number; error?: string }>
}

// Tags types (for sidebar drill-down)
export interface TagNoteItem {
  id: string
  path: string
  title: string
  created: string
  modified: string
  tags: string[]
  wordCount: number
  isPinned: boolean
  pinnedAt: string | null
  emoji?: string | null
}

export interface GetNotesByTagResponse {
  tag: string
  color: string
  count: number
  pinnedNotes: TagNoteItem[]
  unpinnedNotes: TagNoteItem[]
}

export interface TagOperationResponse {
  success: boolean
  error?: string
}

export interface RenameTagResponse extends TagOperationResponse {
  affectedNotes?: number
}

export interface DeleteTagResponse extends TagOperationResponse {
  affectedNotes?: number
}

export interface MergeTagResponse extends TagOperationResponse {
  affectedItems?: number
}

export interface TagWithCount {
  name: string
  count: number
  color?: string
  icon?: string | null
  categoryId?: string | null
  sortOrder?: number
}

export interface GetAllWithCountsResponse {
  tags: TagWithCount[]
}

export interface TagRenamedEvent {
  oldName: string
  newName: string
  affectedNotes: number
}

export interface TagColorUpdatedEvent {
  tag: string
  color: string
}

export interface TagDeletedEvent {
  tag: string
  affectedNotes: number
}

export interface TagNotesChangedEvent {
  tag: string
  noteId: string
  action: 'pinned' | 'unpinned' | 'removed' | 'added'
}

// Tag category types
export interface TagCategoryRow {
  id: string
  name: string
  sortOrder: number
  tagCount: number
}

export interface TagAssignment {
  tag: string
  categoryId: string | null
  sortOrder: number
}

export interface CategoryOperationResponse {
  success: boolean
  error?: string
}

export interface ListCategoriesResponse extends CategoryOperationResponse {
  categories?: TagCategoryRow[]
}

export interface CreateCategoryResponse extends CategoryOperationResponse {
  category?: TagCategoryRow
}

// Tags client API interface
export interface TagsClientAPI {
  getNotesByTag(input: {
    tag: string
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    includeDescendants?: boolean
  }): Promise<GetNotesByTagResponse>
  pinNoteToTag(input: { noteId: string; tag: string }): Promise<TagOperationResponse>
  unpinNoteFromTag(input: { noteId: string; tag: string }): Promise<TagOperationResponse>
  renameTag(input: { oldName: string; newName: string }): Promise<RenameTagResponse>
  updateTagColor(input: { tag: string; color: string }): Promise<TagOperationResponse>
  updateTagIcon(input: { tag: string; icon: string | null }): Promise<TagOperationResponse>
  deleteTag(tag: string): Promise<DeleteTagResponse>
  removeTagFromNote(input: { noteId: string; tag: string }): Promise<TagOperationResponse>
  getAllWithCounts(): Promise<GetAllWithCountsResponse>
  mergeTag(input: { source: string; target: string }): Promise<MergeTagResponse>
  listCategories(): Promise<ListCategoriesResponse>
  createCategory(input: { name: string }): Promise<CreateCategoryResponse>
  renameCategory(input: { id: string; name: string }): Promise<CategoryOperationResponse>
  deleteCategory(input: { id: string }): Promise<CategoryOperationResponse>
  reorder(input: {
    tags?: TagAssignment[]
    categories?: { id: string; sortOrder: number }[]
  }): Promise<CategoryOperationResponse>
}

export type InboxItemType = InboxRpc.InboxItemType
export type InboxProcessingStatus = InboxRpc.InboxProcessingStatus
export type InboxFilingAction = InboxRpc.InboxFilingAction
export type InboxJobType = InboxRpc.InboxJobType
export type InboxJobStatus = InboxRpc.InboxJobStatus
export type InboxItem = InboxRpc.InboxItem
export type InboxItemListItem = InboxRpc.InboxItemListItem
export type InboxListResponse = InboxRpc.InboxListResponse
export type InboxDuplicateMatch = InboxRpc.InboxDuplicateMatch
export type InboxCaptureResponse = InboxRpc.InboxCaptureResponse
export type InboxFileResponse = InboxRpc.InboxFileResponse
export type InboxBulkResponse = InboxRpc.InboxBulkResponse
export type InboxFilingHistoryEntry = InboxRpc.InboxFilingHistoryEntry
export type InboxFilingHistoryResponse = InboxRpc.InboxFilingHistoryResponse
export type InboxFilingSuggestion = InboxRpc.InboxFilingSuggestion
export type InboxSuggestionsResponse = InboxRpc.InboxSuggestionsResponse
export type InboxAgeDistribution = InboxRpc.InboxAgeDistribution
export type InboxStats = InboxRpc.InboxStats
export type InboxCapturePattern = InboxRpc.InboxCapturePattern
export type InboxJob = InboxRpc.InboxJob
export type InboxJobsResponse = InboxRpc.InboxJobsResponse
export type InboxCapturedEvent = InboxRpc.InboxCapturedEvent
export type InboxUpdatedEvent = InboxRpc.InboxUpdatedEvent
export type InboxArchivedEvent = InboxRpc.InboxArchivedEvent
export type InboxFiledEvent = InboxRpc.InboxFiledEvent
export type InboxSnoozedEvent = InboxRpc.InboxSnoozedEvent
export type InboxSnoozeDueEvent = InboxRpc.InboxSnoozeDueEvent
export type InboxTranscriptionCompleteEvent = InboxRpc.InboxTranscriptionCompleteEvent
export type InboxMetadataCompleteEvent = InboxRpc.InboxMetadataCompleteEvent
export type InboxProcessingErrorEvent = InboxRpc.InboxProcessingErrorEvent
export type LinkPreviewData = InboxRpc.LinkPreviewData

export type InboxClientAPI = InboxRpc.InboxClientAPI

// Search types
import type {
  NoteFileType,
  SearchResponse,
  QuickSearchResponse,
  SearchStats,
  SearchReason,
  IndexRebuildProgress
} from '@memry/contracts/search-api'

export interface SearchClientAPI {
  query(params: {
    text: string
    types?: Array<'note' | 'journal' | 'task' | 'inbox'>
    tags?: string[]
    dateRange?: { from: string; to: string } | null
    projectId?: string | null
    folderPath?: string | null
    limit?: number
    offset?: number
    noteFileTypes?: NoteFileType[]
  }): Promise<SearchResponse>
  quick(text: string, noteFileTypes?: NoteFileType[]): Promise<QuickSearchResponse>
  getStats(): Promise<SearchStats>
  rebuildIndex(): Promise<{ started: true }>
  getReasons(): Promise<SearchReason[]>
  addReason(params: {
    itemId: string
    itemType: 'note' | 'journal' | 'task' | 'inbox'
    itemTitle: string
    searchQuery: string
  }): Promise<SearchReason>
  clearReasons(): Promise<{ cleared: true }>
  getAllTags(): Promise<string[]>
}

// Graph API
export interface GraphClientAPI {
  getData(): Promise<{
    nodes: Array<{
      id: string
      type: 'note' | 'task' | 'journal' | 'project'
      label: string
      tags: string[]
      wordCount: number
      connectionCount: number
      emoji: string | null
      color: string
      isOrphan: boolean
      isUnresolved: boolean
    }>
    edges: Array<{
      id: string
      source: string
      target: string
      type: 'wikilink' | 'task-note' | 'project-task' | 'tag-cooccurrence' | 'relation'
      weight: number
    }>
  }>
  getLocal(params: { noteId: string; depth?: number }): Promise<{
    nodes: Array<{
      id: string
      type: 'note' | 'task' | 'journal' | 'project'
      label: string
      tags: string[]
      wordCount: number
      connectionCount: number
      emoji: string | null
      color: string
      isOrphan: boolean
      isUnresolved: boolean
    }>
    edges: Array<{
      id: string
      source: string
      target: string
      type: 'wikilink' | 'task-note' | 'project-task' | 'tag-cooccurrence' | 'relation'
      weight: number
    }>
  }>
}

// Quick Capture types
export interface QuickCaptureClientAPI {
  /** Close the quick capture window */
  close(): void
  /** Get current clipboard text content */
  getClipboard(): Promise<string>
  /** Resize the quick capture window height */
  resize(height: number): void
  /** Open the main settings modal to a section */
  openSettings(section?: string): void
}

// Native context menu types
export interface ContextMenuItem {
  id: string
  label: string
  accelerator?: string
  disabled?: boolean
  type?: 'normal' | 'separator'
}

// Settings types
export interface JournalSettings {
  defaultTemplate: string | null
  /** Whether to show the Schedule section in the journal sidebar */
  showSchedule: boolean
  /** Whether to show the Tasks section in the journal sidebar */
  showTasks: boolean
  /** Whether to show the AI Connections panel in the journal sidebar */
  showAIConnections: boolean
  /** Whether to show the stats footer at the bottom of journal entries */
  showStatsFooter: boolean
}

export interface AISettings {
  enabled: boolean
}

export interface AIModelStatus {
  name: string
  dimension: number
  loaded: boolean
  loading: boolean
  error: string | null
  embeddingCount?: number
}

export interface VoiceTranscriptionSettings {
  provider: 'local' | 'openai'
  memoNameMode: 'transcript' | 'timestamp' | 'none'
}

export interface VoiceModelStatus {
  name: string
  downloaded: boolean
  loaded: boolean
  loading: boolean
  error: string | null
}

export interface VoiceRecordingReadiness {
  ready: boolean
  provider: 'local' | 'openai'
  reason?: 'missing-model' | 'missing-api-key'
  message?: string
}

export interface VoiceTranscriptionOpenAIKeyStatus {
  hasApiKey: boolean
}

export interface SettingsChangedEvent {
  key: string
  value: unknown
}

export interface EmbeddingProgressEvent {
  current: number
  total: number
  phase: 'downloading' | 'loading' | 'ready' | 'error' | 'scanning' | 'embedding' | 'complete'
  status?: string
  progress?: number
}

export interface VoiceModelProgressEvent {
  current?: number
  total?: number
  progress?: number
  phase: 'downloading' | 'loading' | 'ready' | 'error'
  status?: string
}

// Reminder types
export type ReminderTargetType = 'note' | 'journal' | 'highlight' | 'task' | 'note_date'
export type ReminderStatus = 'pending' | 'triggered' | 'dismissed' | 'snoozed'

export interface Reminder {
  id: string
  targetType: ReminderTargetType
  targetId: string
  remindAt: string
  anchorId: string | null
  highlightText: string | null
  highlightStart: number | null
  highlightEnd: number | null
  title: string | null
  note: string | null
  status: ReminderStatus
  triggeredAt: string | null
  dismissedAt: string | null
  snoozedUntil: string | null
  createdAt: string
  modifiedAt: string
}

export interface ReminderWithTarget extends Reminder {
  targetTitle: string | null
  targetExists: boolean
  highlightExists?: boolean
  projectId?: string | null
}

export interface CreateReminderInput {
  targetType: ReminderTargetType
  targetId: string
  remindAt: string
  title?: string
  note?: string
  highlightText?: string
  highlightStart?: number
  highlightEnd?: number
}

export interface UpdateReminderInput {
  id: string
  remindAt?: string
  title?: string | null
  note?: string | null
}

export interface SnoozeReminderInput {
  id: string
  snoozeUntil: string
}

export interface ListRemindersInput {
  targetType?: ReminderTargetType
  targetId?: string
  status?: ReminderStatus | ReminderStatus[]
  fromDate?: string
  toDate?: string
  limit?: number
  offset?: number
}

export interface ReminderListResponse {
  reminders: ReminderWithTarget[]
  total: number
  hasMore: boolean
}

export interface ReminderCreateResponse {
  success: boolean
  reminder: Reminder | null
  error?: string
}

export interface ReminderUpdateResponse {
  success: boolean
  reminder: Reminder | null
  error?: string
}

export interface ReminderDeleteResponse {
  success: boolean
  error?: string
}

export interface ReminderDismissResponse {
  success: boolean
  reminder: Reminder | null
  error?: string
}

export interface ReminderSnoozeResponse {
  success: boolean
  reminder: Reminder | null
  error?: string
}

export interface BulkDismissResponse {
  success: boolean
  dismissedCount: number
  error?: string
}

// Reminder event types
//
// Two producers, two payload shapes: the local IPC path (main/lib/reminders.ts)
// sends the resolved row, while the sync handler
// (main/sync/item-handlers/reminder-handler.ts) has no resolved row for an
// inbound change and sends only `{ id }`. Consumers must tolerate both.
export interface ReminderCreatedEvent {
  reminder?: Reminder
  id?: string
}

export interface ReminderUpdatedEvent {
  reminder?: Reminder
  id?: string
}

export interface ReminderDeletedEvent {
  id: string
  targetType?: string
  targetId?: string
}

export interface ReminderDueEvent {
  reminders: ReminderWithTarget[]
  count: number
}

export interface ReminderDismissedEvent {
  reminder: Reminder
}

export interface ReminderSnoozedEvent {
  reminder: Reminder
}

export interface ReminderClickedEvent {
  reminder: ReminderWithTarget
}

// Reminders client API interface
export interface RemindersClientAPI {
  create(input: CreateReminderInput): Promise<ReminderCreateResponse>
  update(input: UpdateReminderInput): Promise<ReminderUpdateResponse>
  delete(id: string): Promise<ReminderDeleteResponse>
  get(id: string): Promise<ReminderWithTarget | null>
  list(options?: ListRemindersInput): Promise<ReminderListResponse>
  getUpcoming(days?: number): Promise<ReminderListResponse>
  getDue(): Promise<ReminderWithTarget[]>
  getForTarget(input: { targetType: ReminderTargetType; targetId: string }): Promise<Reminder[]>
  countPending(): Promise<number>
  dismiss(id: string): Promise<ReminderDismissResponse>
  snooze(input: SnoozeReminderInput): Promise<ReminderSnoozeResponse>
  bulkDismiss(input: { reminderIds: string[] }): Promise<BulkDismissResponse>
}

// Folder View client API interface — re-exported from
// @memry/contracts/folder-view-api so this declaration cannot drift from the
// real contract. `folderExists` is a preload-only existence check (T115) not
// modeled in the contract type itself.
export type FolderViewClientAPI = ContractFolderViewClientAPI & {
  /** Check if a folder exists (T115) */
  folderExists(folderPath: string): Promise<boolean>
}

// Tab Settings types
export interface TabSettings {
  /** Restore tabs from last session on app start */
  restoreSessionOnStart: boolean
  /** When to show close button: always, on hover, or only on active tab */
  tabCloseButton: 'always' | 'hover' | 'active'
}

// Note Editor Settings types
export interface NoteEditorSettings {
  /** Toolbar display mode: floating (on selection) or sticky (always visible) */
  toolbarMode: 'floating' | 'sticky'
}

// New settings group types (from @memry/contracts/settings-schemas)
export interface GeneralSettingsDTO {
  theme: 'light' | 'dark' | 'white' | 'system'
  fontSize: 'small' | 'medium' | 'large'
  fontFamily: 'system' | 'serif' | 'sans-serif' | 'monospace' | 'gelasio' | 'geist' | 'inter'
  accentColor: string
  startOnBoot: boolean
  language: Locale
  onboardingCompleted: boolean
  createInSelectedFolder: boolean
  clockFormat: '12h' | '24h'
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YYYY'
}

export interface EditorSettingsDTO {
  width: 'normal' | 'full'
  toolbarMode: 'floating' | 'sticky'
  spellCheck: boolean
}

export interface TaskSettingsDTO {
  defaultProjectId: string | null
  defaultSortOrder: 'manual' | 'dueDate' | 'priority' | 'createdAt'
  defaultView: 'today' | 'all'
  staleInboxDays: number
}

export interface ShortcutBindingDTO {
  key: string
  modifiers: {
    meta?: boolean
    ctrl?: boolean
    shift?: boolean
    alt?: boolean
  }
}

export interface KeyboardShortcutsDTO {
  overrides: Record<string, ShortcutBindingDTO>
  globalCapture: ShortcutBindingDTO | null
}

export interface SyncSettingsDTO {
  enabled: boolean
  autoSync: boolean
}

export interface BackupSettingsDTO {
  autoBackup: boolean
  frequencyHours: number
  maxBackups: number
  lastBackupAt: string | null
}

export interface GraphSettingsDTO {
  layout: 'forceatlas2' | 'circular' | 'random'
  nodeSizing: 'uniform' | 'by-connections' | 'by-word-count'
  showLabels: boolean
  linkDistance: number
  repulsionStrength: number
  showEdgeLabels: boolean
  animateLayout: boolean
  showTagEdges: boolean
}

// Settings client API interface
export interface SettingsClientAPI {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<{ success: boolean; error?: string }>
  getJournalSettings(): Promise<JournalSettings>
  setJournalSettings(
    settings: Partial<JournalSettings>
  ): Promise<{ success: boolean; error?: string }>
  // AI Settings (local model - no API key needed)
  getAISettings(): Promise<AISettings>
  setAISettings(settings: Partial<AISettings>): Promise<{ success: boolean; error?: string }>
  getVoiceTranscriptionSettings(): Promise<VoiceTranscriptionSettings>
  setVoiceTranscriptionSettings(
    settings: Partial<VoiceTranscriptionSettings>
  ): Promise<{ success: boolean; error?: string }>
  getVoiceModelStatus(): Promise<VoiceModelStatus>
  downloadVoiceModel(): Promise<{ success: boolean; error?: string; message?: string }>
  getVoiceRecordingReadiness(): Promise<VoiceRecordingReadiness>
  getVoiceTranscriptionOpenAIKeyStatus(): Promise<VoiceTranscriptionOpenAIKeyStatus>
  setVoiceTranscriptionOpenAIKey(apiKey: string): Promise<{ success: boolean; error?: string }>
  getAIModelStatus(): Promise<AIModelStatus>
  loadAIModel(): Promise<{ success: boolean; error?: string; message?: string }>
  reindexEmbeddings(): Promise<{
    success: boolean
    computed?: number
    skipped?: number
    error?: string
  }>
  // Tab Settings
  getTabSettings(): Promise<TabSettings>
  setTabSettings(settings: Partial<TabSettings>): Promise<{ success: boolean; error?: string }>
  // Note Editor Settings
  getNoteEditorSettings(): Promise<NoteEditorSettings>
  setNoteEditorSettings(
    settings: Partial<NoteEditorSettings>
  ): Promise<{ success: boolean; error?: string }>
  // General Settings
  getStartupThemeSync(): 'light' | 'dark' | 'white' | 'system'
  getGeneralSettings(): Promise<GeneralSettingsDTO>
  setGeneralSettings(
    settings: Partial<GeneralSettingsDTO>
  ): Promise<{ success: boolean; error?: string }>
  // Editor Settings
  getEditorSettings(): Promise<EditorSettingsDTO>
  setEditorSettings(
    settings: Partial<EditorSettingsDTO>
  ): Promise<{ success: boolean; error?: string }>
  // Task Settings
  getTaskSettings(): Promise<TaskSettingsDTO>
  setTaskSettings(settings: Partial<TaskSettingsDTO>): Promise<{ success: boolean; error?: string }>
  // Keyboard Settings
  getKeyboardSettings(): Promise<KeyboardShortcutsDTO>
  setKeyboardSettings(
    settings: Partial<KeyboardShortcutsDTO>
  ): Promise<{ success: boolean; error?: string }>
  resetKeyboardSettings(): Promise<{ success: boolean; error?: string }>
  // Sync Settings
  getSyncSettings(): Promise<SyncSettingsDTO>
  setSyncSettings(settings: Partial<SyncSettingsDTO>): Promise<{ success: boolean; error?: string }>
  // Backup Settings
  getBackupSettings(): Promise<BackupSettingsDTO>
  setBackupSettings(
    settings: Partial<BackupSettingsDTO>
  ): Promise<{ success: boolean; error?: string }>
  getGraphSettings(): Promise<GraphSettingsDTO>
  setGraphSettings(
    settings: Partial<GraphSettingsDTO>
  ): Promise<{ success: boolean; error?: string }>
  registerGlobalCapture(): Promise<{
    success: boolean
    registered: boolean
    permissionRequired?: boolean
    error?: string
  }>
}

// Sync Auth API
interface SyncAuthClientAPI {
  requestOtp: (input: { email: string }) => Promise<{
    success: boolean
    expiresIn?: number
    message?: string
    error?: string
  }>
  verifyOtp: (input: { email: string; code: string }) => Promise<{
    success: boolean
    isNewUser?: boolean
    needsSetup?: boolean
    needsRecoverySetup?: boolean
    needsRecoveryInput?: boolean
    recoveryPhrase?: string
    deviceId?: string
    error?: string
  }>
  resendOtp: (input: { email: string }) => Promise<{
    success: boolean
    expiresIn?: number
    message?: string
    error?: string
  }>
  initOAuth: (input: { provider: 'google' }) => Promise<{
    state: string
  }>
  refreshToken /* auth action */: () => Promise<{
    success: boolean
    error?: string
  }>
  logout: () => Promise<{
    success: boolean
    keychainWarning?: string
  }>
}

// Sync Setup API
interface SyncSetupClientAPI {
  setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) => Promise<{
    success: boolean
    needsRecoverySetup?: boolean
    deviceId?: string
    needsRecoveryInput?: boolean
    error?: string
  }>
  setupNewAccount: () => Promise<{
    success: boolean
    deviceId?: string
    error?: string
  }>
  confirmRecoveryPhrase: (input: { confirmed: boolean }) => Promise<{
    success: boolean
  }>
  getRecoveryPhrase: () => Promise<string | null>
}

// Device Linking API
interface SyncLinkingClientAPI {
  generateLinkingQr: () => Promise<{
    sessionId?: string
    qrData?: string
    expiresAt?: number
  }>
  linkViaQr: (input: { qrData: string; provider?: string; oauthToken?: string }) => Promise<{
    success: boolean
    status?: 'waiting_approval' | 'approved' | 'error'
    verificationCode?: string
    error?: string
  }>
  linkViaRecovery: (input: { recoveryPhrase: string }) => Promise<{
    success: boolean
    deviceId?: string
    error?: string
  }>
  approveLinking: (input: { sessionId: string }) => Promise<{
    success: boolean
    error?: string
  }>
  getLinkingSas: (input: { sessionId: string }) => Promise<{
    verificationCode?: string
    error?: string
  }>
  completeLinkingQr: (input: { sessionId: string }) => Promise<{
    success: boolean
    deviceId?: string
    error?: string
    vaults?: Array<{ vaultUuid: string; itemCount?: number; createdAt?: number | null }>
  }>
  finalizeVaultChoice: (input: {
    sessionId: string
    parentFolderPath: string
    selectedVaultUuids: string[]
    primaryVaultUuid: string
  }) => Promise<{ success: boolean; error?: string }>
  pickVaultFolder: () => Promise<{ path: string | null }>
}

// Account API
type BillingPlanId = 'plus' | 'pro' | 'believer'
type BillingPlan = 'free' | BillingPlanId
type BillingStatusValue = 'inactive' | 'active' | 'past_due' | 'paused' | 'canceled'

interface BillingStatus {
  plan: BillingPlan
  status: BillingStatusValue
  source: string
  email: string | null
  limits: {
    storageLimit: number
    maxFileSize: number
    maxVaults: number | null
    versionHistoryDays: number
  }
  usage: {
    storageUsed: number
  }
  expiresAt: number | null
  canManageBilling: boolean
}

interface BillingActionResult {
  success: boolean
  error?: string
}

interface AccountClientAPI {
  getInfo: () => Promise<{ email: string | null; joinedAt: number | null }>
  signOut: () => Promise<{ success: boolean; keychainWarning?: string }>
  startCheckout: () => Promise<BillingActionResult & { checkoutUrl?: string }>
  getBillingStatus: () => Promise<BillingStatus | (BillingActionResult & { status?: never })>
  refreshBillingStatus: (input?: {
    transactionId?: string
  }) => Promise<BillingStatus | (BillingActionResult & { status?: never })>
  openBillingPortal: () => Promise<BillingActionResult & { portalUrl?: string }>
}

// Device Management API
interface SyncDevicesClientAPI {
  getDevices: () => Promise<{
    devices: Array<{
      id: string
      name: string
      platform: string
      isCurrentDevice: boolean
      lastSyncAt?: number
      linkedAt: number
    }>
    email?: string
    needsRecoveryConfirmation: boolean
  }>
  removeDevice: (input: { deviceId: string }) => Promise<{
    success: boolean
    error?: string
  }>
  renameDevice: (input: { deviceId: string; newName: string }) => Promise<{
    success: boolean
    error?: string
  }>
}

// Sync Operations API
interface SyncOpsClientAPI {
  getStatus: () => Promise<{
    status: string
    lastSyncAt?: number
    pendingCount: number
    error?: string
    offlineSince?: number
  }>
  triggerSync: () => Promise<{
    success: boolean
    error?: string
  }>
  getHistory: (input: { limit?: number; offset?: number }) => Promise<{
    entries: Array<{
      id: string
      type: string
      direction: string
      itemCount: number
      details: string
      durationMs?: number
      createdAt: number
    }>
    total: number
  }>
  getQueueSize: () => Promise<{
    pending: number
    failed: number
  }>
  pause: () => Promise<{
    success: boolean
    wasPaused: boolean
  }>
  resume: () => Promise<{
    success: boolean
    pendingCount: number
  }>
  updateSyncedSetting: (
    fieldPath: string,
    value: unknown
  ) => Promise<{ success: boolean; error?: string }>
  getSyncedSettings: () => Promise<
    import('../shared/contracts/settings-sync').SyncedSettings | null
  >
  getStorageBreakdown: () => Promise<{
    used: number
    limit: number
    breakdown: {
      notes: number
      attachments: number
      crdt: number
      other: number
    }
  } | null>
}

// Crypto API
interface CryptoClientAPI {
  encryptItem: (input: {
    itemId: string
    type: 'note' | 'task' | 'project' | 'settings'
    content: Record<string, unknown>
    operation?: 'create' | 'update' | 'delete'
    deletedAt?: number
    metadata?: Record<string, unknown>
  }) => Promise<{
    encryptedKey: string
    keyNonce: string
    encryptedData: string
    dataNonce: string
    signature: string
  }>
  decryptItem: (input: {
    itemId: string
    type: 'note' | 'task' | 'project' | 'settings'
    encryptedKey: string
    keyNonce: string
    encryptedData: string
    dataNonce: string
    signature: string
    operation?: 'create' | 'update' | 'delete'
    deletedAt?: number
    metadata?: Record<string, unknown>
  }) => Promise<{
    success: boolean
    content?: Record<string, unknown>
    error?: string
  }>
  verifySignature: (input: {
    itemId: string
    type: 'note' | 'task' | 'project' | 'settings'
    encryptedKey: string
    keyNonce: string
    encryptedData: string
    dataNonce: string
    signature: string
    operation?: 'create' | 'update' | 'delete'
    deletedAt?: number
    metadata?: Record<string, unknown>
  }) => Promise<{
    valid: boolean
  }>
}

// Attachment Sync API
interface SyncAttachmentsClientAPI {
  upload: (input: { noteId: string; filePath: string }) => Promise<{
    success: boolean
    sessionId?: string
    attachmentId?: string
    error?: string
  }>
  getUploadProgress: (input: { sessionId: string }) => Promise<{
    status: string
    uploadedChunks: number
    totalChunks: number
    progress: number
  }>
  download: (input: { attachmentId: string; targetPath: string }) => Promise<{
    success: boolean
    filePath?: string
    error?: string
  }>
  getDownloadProgress: (input: { attachmentId: string }) => Promise<{
    status: string
    downloadedChunks: number
    totalChunks: number
    progress: number
  }>
}

// Window controls API
interface WindowAPI {
  windowMinimize: () => void
  windowMaximize: () => void
  windowClose: () => void
}

interface AgentMcpClientAPI {
  getStatus: () => Promise<AgentMcpStatus>
  rotateToken: () => Promise<AgentMcpStatus>
}

interface AgentClientAPI {
  listConversations: (input?: { vaultId?: string }) => Promise<Conversation[]>
  createConversation: (input?: {
    vaultId?: string
    backend?: AgentBackendId
    backendModel?: string | null
  }) => Promise<Conversation>
  loadConversation: (input: { id: string }) => Promise<{
    conversation: Conversation | null
    messages: Message[]
  }>
  sendTurn: (input: SendTurnRequest) => Promise<SendTurnResponse>
  cancelTurn: (input: { conversationId: string }) => Promise<{ ok: boolean }>
  approveTool: (input: ApproveToolRequest) => Promise<{ ok: boolean }>
  previewDiff: (input: PreviewDiffRequest) => Promise<PreviewDiffResponse>
  editTrustList: (input: {
    conversationId: string
    add?: string[]
    remove?: string[]
  }) => Promise<Conversation | null>
  getBackendStatuses: () => Promise<BackendStatusesResponse>
  listBackendModels: (input: AgentBackendModelListRequest) => Promise<AgentBackendModelList>
  getLocalProviderSettings: () => Promise<AgentLocalProviderSettings>
  setLocalProviderSettings: (
    input: AgentLocalProviderSettingsUpdate
  ) => Promise<AgentLocalProviderSettings>
  getPreferences: () => Promise<AgentPreferences>
  setPreferences: (input: AgentPreferencesUpdate) => Promise<AgentPreferences>
  listLocalModels: () => Promise<AgentLocalModelList>
  testLocalProvider: () => Promise<AgentLocalProviderProbeResult>
  probeLocalProvider: () => Promise<AgentLocalProviderProbeResult>
  acceptDisclosure: () => Promise<{ accepted: boolean }>
  getDisclosureState: () => Promise<{ accepted: boolean }>
  getWindowId: () => Promise<{ windowId: string | null }>
  onEvent: (callback: (event: AgentEvent) => void) => () => void
}

interface MainInvokePayload {
  requestId: string
  channel: string
  payload?: unknown
}

// Full API interface
interface API extends WindowAPI, GeneratedRpcApi {
  getFileDropPaths: (files: File[]) => string[]
  vault: VaultClientAPI
  properties: PropertiesClientAPI
  savedFilters: SavedFiltersClientAPI
  templates: TemplatesClientAPI
  journal: JournalClientAPI
  bookmarks: BookmarksClientAPI
  tags: TagsClientAPI
  reminders: RemindersClientAPI
  search: SearchClientAPI
  graph: GraphClientAPI
  quickCapture: QuickCaptureClientAPI
  folderView: FolderViewClientAPI
  locale: LocaleApi
  syncAuth: SyncAuthClientAPI
  syncSetup: SyncSetupClientAPI
  syncLinking: SyncLinkingClientAPI
  account: AccountClientAPI
  syncDevices: SyncDevicesClientAPI
  syncOps: SyncOpsClientAPI
  crypto: CryptoClientAPI
  syncAttachments: SyncAttachmentsClientAPI
  homePages: HomePagesClientAPI
  agentMcp: AgentMcpClientAPI
  agent: AgentClientAPI
  import: {
    pickFiles: (input: ImportPickFilesInput) => Promise<ImportPickFilesResult>
    start: (input: ImportStartInput) => Promise<ImportStartResponse>
    cancel: (input: ImportCancelInput) => Promise<{ success: true }>
    preview: (input: ImportPreviewInput) => Promise<ImportPreviewResponse>
    list: () => Promise<ImporterMeta[]>
  }
  updater: {
    getState: () => Promise<AppUpdateState>
    checkForUpdates: () => Promise<AppUpdateState>
    downloadUpdate: () => Promise<AppUpdateState>
    quitAndInstall: () => Promise<void>
    skipVersion: (version: string) => Promise<AppUpdateState>
    setAutoDownload: (enabled: boolean) => Promise<AppUpdateState>
    setAutoCheck: (enabled: boolean) => Promise<AppUpdateState>
  }
  syncCrdt: {
    openDoc: (input: { noteId: string }) => Promise<CrdtOpenDocResult>
    closeDoc: (input: { noteId: string }) => Promise<void>
    applyUpdate: (input: { noteId: string; update: number[] }) => Promise<void>
    syncStep1: (input: {
      noteId: string
      stateVector: number[]
    }) => Promise<CrdtSyncStep1Result | null>
    syncStep2: (input: { noteId: string; diff: number[] }) => Promise<void>
  }
  /** Show a native OS context menu and return the selected item id, or null if dismissed */
  showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>
  // Vault event subscriptions
  onVaultStatusChanged: (callback: (status: VaultStatus) => void) => () => void
  onVaultIndexProgress: (callback: (progress: number) => void) => () => void
  onVaultError: (callback: (error: string) => void) => () => void
  onVaultIndexRecovered: (callback: (event: IndexRecoveredEvent) => void) => () => void
  // Saved Filters event subscriptions
  onSavedFilterCreated: (callback: (event: SavedFilterCreatedEvent) => void) => () => void
  onSavedFilterUpdated: (callback: (event: SavedFilterUpdatedEvent) => void) => () => void
  onSavedFilterDeleted: (callback: (event: SavedFilterDeletedEvent) => void) => () => void
  // Templates event subscriptions
  onTemplateCreated: (callback: (event: TemplateCreatedEvent) => void) => () => void
  onTemplateUpdated: (callback: (event: TemplateUpdatedEvent) => void) => () => void
  onTemplateDeleted: (callback: (event: TemplateDeletedEvent) => void) => () => void
  // Journal event subscriptions
  onJournalEntryCreated: (callback: (event: JournalEntryCreatedEvent) => void) => () => void
  onJournalEntryUpdated: (callback: (event: JournalEntryUpdatedEvent) => void) => () => void
  onJournalEntryDeleted: (callback: (event: JournalEntryDeletedEvent) => void) => () => void
  onJournalExternalChange: (callback: (event: JournalExternalChangeEvent) => void) => () => void
  // Bookmarks event subscriptions
  onBookmarkCreated: (callback: (event: BookmarkCreatedEvent) => void) => () => void
  onBookmarkUpdated: (callback: (event: BookmarkUpdatedEvent) => void) => () => void
  onBookmarkDeleted: (callback: (event: BookmarkDeletedEvent) => void) => () => void
  onBookmarksReordered: (callback: (event: BookmarksReorderedEvent) => void) => () => void
  // Tags event subscriptions
  onTagRenamed: (callback: (event: TagRenamedEvent) => void) => () => void
  onTagColorUpdated: (callback: (event: TagColorUpdatedEvent) => void) => () => void
  onTagDeleted: (callback: (event: TagDeletedEvent) => void) => () => void
  onTagNotesChanged: (callback: (event: TagNotesChangedEvent) => void) => () => void
  onTagCategoriesChanged: (callback: () => void) => () => void
  // Reminder event subscriptions
  onReminderCreated: (callback: (event: ReminderCreatedEvent) => void) => () => void
  onReminderUpdated: (callback: (event: ReminderUpdatedEvent) => void) => () => void
  onReminderDeleted: (callback: (event: ReminderDeletedEvent) => void) => () => void
  onReminderDue: (callback: (event: ReminderDueEvent) => void) => () => void
  onReminderDismissed: (callback: (event: ReminderDismissedEvent) => void) => () => void
  onReminderSnoozed: (callback: (event: ReminderSnoozedEvent) => void) => () => void
  onReminderClicked: (callback: (event: ReminderClickedEvent) => void) => () => void
  // Inbox review event subscriptions
  onInboxReviewDue: (callback: (event: { count: number }) => void) => () => void
  onInboxReviewOpen: (callback: () => void) => () => void
  // Folder View event subscriptions
  onFolderViewConfigUpdated: (callback: (event: FolderViewConfigUpdatedEvent) => void) => () => void
  // Search event subscriptions
  onSearchIndexRebuildStarted: (callback: () => void) => () => void
  onSearchIndexRebuildProgress: (callback: (progress: IndexRebuildProgress) => void) => () => void
  onSearchIndexRebuildCompleted: (callback: () => void) => () => void
  onSearchIndexCorrupt: (callback: () => void) => () => void
  // Sync event subscriptions
  onSyncStatusChanged: (callback: (event: SyncStatusChangedEvent) => void) => () => void
  onItemSynced: (callback: (event: ItemSyncedEvent) => void) => () => void
  onConflictDetected: (callback: (event: ConflictDetectedEvent) => void) => () => void
  onLinkingRequest: (callback: (event: LinkingRequestEvent) => void) => () => void
  onLinkingApproved: (callback: (event: LinkingApprovedEvent) => void) => () => void
  onLinkingFinalized: (callback: (event: LinkingFinalizedEvent) => void) => () => void
  onUploadProgress: (callback: (event: UploadProgressEvent) => void) => () => void
  onDownloadProgress: (callback: (event: DownloadProgressEvent) => void) => () => void
  onAttachmentUploadFailed: (callback: (event: AttachmentUploadFailedEvent) => void) => () => void
  onInitialSyncProgress: (callback: (event: InitialSyncProgressEvent) => void) => () => void
  onQueueCleared: (callback: (event: QueueClearedEvent) => void) => () => void
  onSyncPaused: (callback: (event: SyncPausedEvent) => void) => () => void
  onSyncResumed: (callback: (event: SyncResumedEvent) => void) => () => void
  onSessionExpired: (callback: (event: SessionExpiredEvent) => void) => () => void
  onDeviceRevoked: (callback: (event: DeviceRevokedEvent) => void) => () => void
  onOtpDetected: (callback: (event: OtpDetectedEvent) => void) => () => void
  onOAuthCallback: (callback: (event: OAuthCallbackEvent) => void) => () => void
  onOAuthError: (callback: (event: OAuthErrorEvent) => void) => () => void
  onClockSkewWarning: (callback: (event: ClockSkewWarningEvent) => void) => () => void
  onSecurityWarning: (callback: (event: SecurityWarningEvent) => void) => () => void
  onCertificatePinFailed: (callback: (event: CertificatePinFailedEvent) => void) => () => void
  onVaultRecoveryNeeded: (callback: (event: VaultRecoveryNeededEvent) => void) => () => void
  onUpdaterStateChanged: (callback: (state: AppUpdateState) => void) => () => void
  onImportProgress: (callback: (event: ImportProgressEvent) => void) => () => void
  onAppNavigationCommand: (callback: (command: AppNavigationCommandEvent) => void) => () => void
  onMenuCommand: (callback: (event: AppMenuCommandEvent) => void) => () => void
  onLocaleChanged: (callback: (locale: Locale) => void) => () => void
  onMainInvoke: (callback: (payload: MainInvokePayload) => void | Promise<void>) => () => void
  respondToMainInvoke: (requestId: string, response: unknown) => void
  onCrdtStateChanged: (
    callback: (data: { noteId: string; update: number[]; origin: string }) => void
  ) => () => void
  onFlushRequested: (callback: () => void) => () => void
  notifyFlushDone: () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: API
  }
}

export {}
