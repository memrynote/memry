import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  SyncStatusChangedEvent,
  ItemSyncedEvent,
  ConflictDetectedEvent,
  LinkingRequestEvent,
  LinkingApprovedEvent,
  UploadProgressEvent,
  DownloadProgressEvent,
  InitialSyncProgressEvent,
  QueueClearedEvent,
  SyncPausedEvent,
  SyncResumedEvent,
  KeyRotationProgressEvent,
  SessionExpiredEvent,
  OtpDetectedEvent,
  OAuthCallbackEvent
} from '../shared/contracts/ipc-sync'

// Vault types (mirrored from contracts for preload compatibility)
export interface VaultInfo {
  path: string
  name: string
  noteCount: number
  taskCount: number
  lastOpened: string
  isDefault: boolean
}

// Note types (mirrored from contracts for preload compatibility)
export interface NoteFrontmatter {
  id: string
  title?: string
  created: string
  modified: string
  tags?: string[]
  aliases?: string[]
  [key: string]: unknown
}

export interface Note {
  id: string
  path: string
  title: string
  content: string
  frontmatter: NoteFrontmatter
  created: Date
  modified: Date
  tags: string[]
  aliases: string[]
  wordCount: number
  properties: Record<string, unknown> // T020: Properties support
  emoji?: string | null // T028: Emoji icon for visual identification
}

// T020: Property types
export type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'rating'

export interface PropertyValue {
  name: string
  value: unknown
  type: PropertyType
}

export interface PropertyDefinition {
  name: string
  type: PropertyType
  options: string | null // JSON array
  defaultValue: string | null
  color: string | null
  createdAt: string
}

export interface CreatePropertyDefinitionInput {
  name: string
  type: PropertyType
  options?: string[]
  defaultValue?: unknown
  color?: string
}

export interface UpdatePropertyDefinitionInput {
  name: string
  type?: PropertyType
  options?: string[]
  defaultValue?: unknown
  color?: string
}

export interface SetPropertiesResponse {
  success: boolean
  error?: string
}

export interface CreatePropertyDefinitionResponse {
  success: boolean
  definition: PropertyDefinition | null
  error?: string
}

// T070: Attachment types
export interface AttachmentResult {
  success: boolean
  /** Relative path from note to attachment */
  path?: string
  /** Original filename */
  name?: string
  /** File size in bytes */
  size?: number
  /** MIME type */
  mimeType?: string
  /** Category: image or file */
  type?: 'image' | 'file'
  /** Error message if failed */
  error?: string
}

export interface AttachmentInfo {
  filename: string
  path: string
  size: number
  mimeType: string
  type: 'image' | 'file'
}

export interface DeleteAttachmentResponse {
  success: boolean
  error?: string
}

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

export interface FolderConfig {
  template?: string
  inherit?: boolean
}

// Export types (T106, T108)
export interface ExportNoteInput {
  noteId: string
  includeMetadata?: boolean
  pageSize?: 'A4' | 'Letter' | 'Legal'
}

export interface ExportNoteResponse {
  success: boolean
  path?: string
  error?: string
}

// Version History types (T110-T114)
export type SnapshotReason = 'manual' | 'auto' | 'timer' | 'significant'

export interface SnapshotListItem {
  id: string
  noteId: string
  title: string
  wordCount: number
  reason: SnapshotReason
  createdAt: string
}

export interface SnapshotDetail extends SnapshotListItem {
  fileContent: string // Full file content (frontmatter + markdown body)
}

export interface RestoreVersionResponse {
  success: boolean
  note: Note | null
  error?: string
}

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

export interface NoteListItem {
  id: string
  path: string
  title: string
  created: Date
  modified: Date
  tags: string[]
  wordCount: number
  snippet?: string
  emoji?: string | null // T028: Emoji icon for visual identification
  fileType?: 'markdown' | 'pdf' | 'image' | 'audio' | 'video' // File type discriminator
  mimeType?: string | null // MIME type (e.g., 'application/pdf')
  fileSize?: number | null // File size in bytes
}

/**
 * File metadata for non-markdown files (PDF, image, audio, video)
 */
export interface FileMetadata {
  id: string
  path: string // Relative path within vault
  absolutePath: string // Full filesystem path for viewers
  title: string
  fileType: 'pdf' | 'image' | 'audio' | 'video'
  mimeType: string | null
  fileSize: number | null
  created: Date
  modified: Date
}

/**
 * WikiLink resolution result for format-aware link handling.
 * Used to determine whether to open a note or file viewer.
 */
export interface WikiLinkResolution {
  id: string
  path: string
  title: string
  fileType: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
}

export interface NoteCreateInput {
  title: string
  content?: string
  folder?: string
  tags?: string[]
  template?: string
}

export interface NoteUpdateInput {
  id: string
  title?: string
  content?: string
  tags?: string[]
  frontmatter?: Record<string, unknown>
  emoji?: string | null // T028: Emoji icon for visual identification
}

export interface NoteListOptions {
  folder?: string
  tags?: string[]
  sortBy?: 'modified' | 'created' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface NoteCreateResponse {
  success: boolean
  note: Note | null
  error?: string
}

export interface NoteUpdateResponse {
  success: boolean
  note: Note | null
  error?: string
}

export interface NoteListResponse {
  notes: NoteListItem[]
  total: number
  hasMore: boolean
}

export interface NoteLink {
  sourceId: string
  targetId: string | null
  targetTitle: string
  lineNumber: number
}

export interface Backlink {
  sourceId: string
  sourcePath: string
  sourceTitle: string
  context: string
  lineNumber: number
}

export interface NoteLinksResponse {
  outgoing: NoteLink[]
  incoming: Backlink[]
}

export interface NoteCreatedEvent {
  note: NoteListItem
  source: 'internal' | 'external'
}

export interface NoteUpdatedEvent {
  id: string
  changes: Partial<Note>
  source: 'internal' | 'external'
}

export interface NoteDeletedEvent {
  id: string
  path: string
  source: 'internal' | 'external'
}

export interface NoteRenamedEvent {
  id: string
  oldPath: string
  newPath: string
  oldTitle: string
  newTitle: string
}

export interface NoteMovedEvent {
  id: string
  oldPath: string
  newPath: string
}

export interface NoteExternalChangeEvent {
  id: string
  path: string
  type: 'modified' | 'deleted'
}

// Search types (mirrored from contracts for preload compatibility)
export interface SearchResultNote {
  type: 'note'
  id: string
  path: string
  title: string
  snippet: string
  score: number
  matchedIn: ('title' | 'content' | 'tags')[]
  created: string
  modified: string
  tags: string[]
}

export interface SearchResultTask {
  type: 'task'
  id: string
  title: string
  snippet: string | null
  score: number
  matchedIn: ('title' | 'description' | 'tags')[]
  projectId: string
  projectName: string
  dueDate: string | null
  priority: 0 | 1 | 2 | 3
  completed: boolean
}

export type SearchResult = SearchResultNote | SearchResultTask

export interface SearchSuggestion {
  text: string
  type: 'recent' | 'tag' | 'title' | 'completion'
  count?: number
}

export interface SearchStats {
  totalNotes: number
  totalTasks: number
  totalJournals: number
  lastIndexed: string
  indexHealth: 'healthy' | 'rebuilding' | 'corrupt'
}

export interface SearchQueryInput {
  query: string
  types?: ('note' | 'task' | 'journal')[]
  tags?: string[]
  projectId?: string
  dateFrom?: string
  dateTo?: string
  includeArchived?: boolean
  includeCompleted?: boolean
  sortBy?: 'relevance' | 'modified' | 'created'
  limit?: number
  offset?: number
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
  hasMore: boolean
  queryTime: number
  suggestions?: string[]
}

export interface QuickSearchResponse {
  notes: SearchResultNote[]
  tasks: SearchResultTask[]
}

export interface SuggestionsResponse {
  suggestions: SearchSuggestion[]
}

export interface IndexRebuildProgressEvent {
  phase: 'scanning' | 'indexing' | 'optimizing'
  current: number
  total: number
  percentage: number
}

export interface IndexRebuildCompletedEvent {
  duration: number
  notesIndexed: number
  tasksIndexed: number
}

export interface IndexRecoveredEvent {
  reason: 'corrupt' | 'missing' | 'healthy'
  filesIndexed: number
  duration: number
}

// RepeatConfig type (matches frontend format for full feature support)
export interface RepeatConfig {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  daysOfWeek?: number[]
  monthlyType?: 'dayOfMonth' | 'weekPattern'
  dayOfMonth?: number
  weekOfMonth?: number
  dayOfWeekForMonth?: number
  endType: 'never' | 'date' | 'count'
  endDate?: string | null
  endCount?: number
  completedCount: number
  createdAt: string
}

// Task types (mirrored from contracts for preload compatibility)
export interface Task {
  id: string
  projectId: string
  statusId: string | null
  parentId: string | null
  title: string
  description: string | null
  priority: 0 | 1 | 2 | 3 | 4
  position: number
  dueDate: string | null
  dueTime: string | null
  startDate: string | null
  repeatConfig: RepeatConfig | null
  repeatFrom: 'due' | 'completion' | null
  sourceNoteId: string | null
  completedAt: string | null
  archivedAt: string | null
  createdAt: string
  modifiedAt: string
  // Enriched properties
  tags?: string[]
  linkedNoteIds?: string[]
  hasSubtasks?: boolean
  subtaskCount?: number
  completedSubtaskCount?: number
}

export interface TaskListItem extends Task {
  tags: string[]
  hasSubtasks: boolean
  subtaskCount: number
  completedSubtaskCount: number
}

export interface Project {
  id: string
  name: string
  description: string | null
  color: string
  icon: string | null
  position: number
  isInbox: boolean
  createdAt: string
  modifiedAt: string
  archivedAt: string | null
}

export interface ProjectWithStats extends Project {
  taskCount: number
  completedCount: number
  overdueCount: number
}

export interface ProjectWithStatuses extends Project {
  statuses: Status[]
}

export interface Status {
  id: string
  projectId: string
  name: string
  color: string
  position: number
  isDefault: boolean
  isDone: boolean
  createdAt: string
}

export interface TaskCreateInput {
  projectId: string
  title: string
  description?: string | null
  priority?: number
  statusId?: string | null
  parentId?: string | null
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  isRepeating?: boolean
  repeatConfig?: RepeatConfig | null
  repeatFrom?: 'due' | 'completion' | null
  tags?: string[]
  linkedNoteIds?: string[]
  position?: number
}

export interface TaskUpdateInput {
  id: string
  title?: string
  description?: string | null
  priority?: number
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  dueDate?: string | null
  dueTime?: string | null
  startDate?: string | null
  isRepeating?: boolean
  repeatConfig?: RepeatConfig | null
  repeatFrom?: 'due' | 'completion' | null
  tags?: string[]
  linkedNoteIds?: string[]
}

export interface TaskListOptions {
  projectId?: string
  statusId?: string | null
  parentId?: string | null
  includeCompleted?: boolean
  includeArchived?: boolean
  dueBefore?: string
  dueAfter?: string
  tags?: string[]
  search?: string
  sortBy?: 'position' | 'dueDate' | 'priority' | 'created' | 'modified'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface TaskCreateResponse {
  success: boolean
  task: Task | null
  error?: string
}

export interface TaskListResponse {
  tasks: TaskListItem[]
  total: number
  hasMore: boolean
}

export interface ProjectCreateInput {
  name: string
  description?: string | null
  color?: string
  icon?: string | null
}

export interface ProjectUpdateInput {
  id: string
  name?: string
  description?: string | null
  color?: string
  icon?: string | null
}

export interface ProjectListResponse {
  projects: ProjectWithStats[]
}

export interface StatusCreateInput {
  projectId: string
  name: string
  color?: string
  isDone?: boolean
}

export interface TaskStats {
  total: number
  completed: number
  overdue: number
  dueToday: number
  dueThisWeek: number
}

export interface TaskMoveInput {
  taskId: string
  targetProjectId?: string
  targetStatusId?: string | null
  targetParentId?: string | null
  position: number
}

export interface TaskCreatedEvent {
  task: Task
}

export interface TaskUpdatedEvent {
  id: string
  task: Task
  changes: Partial<Task>
}

export interface TaskDeletedEvent {
  id: string
}

export interface TaskCompletedEvent {
  id: string
  task: Task
}

export interface TaskMovedEvent {
  id: string
  task: Task
}

export interface ProjectCreatedEvent {
  project: Project
}

export interface ProjectUpdatedEvent {
  id: string
  project: Project
}

export interface ProjectDeletedEvent {
  id: string
}

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
  dueDate: DueDateFilter
  statusIds: string[]
  completion: 'active' | 'completed' | 'all'
  repeatType: 'all' | 'repeating' | 'one-time'
  hasTime: 'all' | 'with-time' | 'without-time'
}

export interface TaskSortConfig {
  field: 'dueDate' | 'priority' | 'createdAt' | 'title' | 'project' | 'completedAt'
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
}

// Notes client API interface
export interface NotesClientAPI {
  create(input: NoteCreateInput): Promise<NoteCreateResponse>
  get(id: string): Promise<Note | null>
  getByPath(path: string): Promise<Note | null>
  getFile(id: string): Promise<FileMetadata | null>
  resolveByTitle(title: string): Promise<WikiLinkResolution | null>
  update(input: NoteUpdateInput): Promise<NoteUpdateResponse>
  rename(id: string, newTitle: string): Promise<NoteUpdateResponse>
  move(id: string, newFolder: string): Promise<NoteUpdateResponse>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  list(options?: NoteListOptions): Promise<NoteListResponse>
  getTags(): Promise<{ tag: string; color: string; count: number }[]>
  getLinks(id: string): Promise<NoteLinksResponse>
  getFolders(): Promise<string[]>
  createFolder(path: string): Promise<{ success: boolean; error?: string }>
  renameFolder(oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }>
  deleteFolder(path: string): Promise<{ success: boolean; error?: string }>
  exists(titleOrPath: string): Promise<boolean>
  openExternal(id: string): Promise<void>
  revealInFinder(id: string): Promise<void>
  // Property Definitions API (T017-T018)
  // Note: get/set properties moved to unified PropertiesClientAPI
  getPropertyDefinitions(): Promise<PropertyDefinition[]>
  createPropertyDefinition(
    input: CreatePropertyDefinitionInput
  ): Promise<CreatePropertyDefinitionResponse>
  updatePropertyDefinition(
    input: UpdatePropertyDefinitionInput
  ): Promise<CreatePropertyDefinitionResponse>
  // T070: Attachments API
  uploadAttachment(noteId: string, file: File): Promise<AttachmentResult>
  listAttachments(noteId: string): Promise<AttachmentInfo[]>
  deleteAttachment(noteId: string, filename: string): Promise<DeleteAttachmentResponse>
  // Folder config API (T096.5)
  getFolderConfig(folderPath: string): Promise<FolderConfig | null>
  setFolderConfig(
    folderPath: string,
    config: FolderConfig
  ): Promise<{ success: boolean; error?: string }>
  getFolderTemplate(folderPath: string): Promise<string | null>
  // Export API (T106, T108)
  exportPdf(input: ExportNoteInput): Promise<ExportNoteResponse>
  exportHtml(input: ExportNoteInput): Promise<ExportNoteResponse>
  // Version History API (T114)
  getVersions(noteId: string): Promise<SnapshotListItem[]>
  getVersion(snapshotId: string): Promise<SnapshotDetail | null>
  restoreVersion(snapshotId: string): Promise<RestoreVersionResponse>
  deleteVersion(snapshotId: string): Promise<{ success: boolean; error?: string }>
  // Position/Reorder API
  getPositions(folderPath: string): Promise<Map<string, number>>
  getAllPositions(): Promise<{
    success: boolean
    positions: Record<string, number>
    error?: string
  }>
  reorder(folderPath: string, notePaths: string[]): Promise<{ success: boolean; error?: string }>

  // File import API
  importFiles(
    sourcePaths: string[],
    targetFolder?: string
  ): Promise<{ success: boolean; imported: number; failed: number; errors: string[] }>
  showImportDialog(): Promise<{ canceled: boolean; filePaths: string[] }>
}

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
}

// Tasks client API interface
export interface TasksClientAPI {
  // Task CRUD
  create(input: TaskCreateInput): Promise<TaskCreateResponse>
  get(id: string): Promise<Task | null>
  update(input: TaskUpdateInput): Promise<TaskCreateResponse>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  list(options?: TaskListOptions): Promise<TaskListResponse>

  // Task actions
  complete(input: { id: string; completedAt?: string }): Promise<TaskCreateResponse>
  uncomplete(id: string): Promise<TaskCreateResponse>
  archive(id: string): Promise<{ success: boolean; error?: string }>
  unarchive(id: string): Promise<{ success: boolean; error?: string }>
  move(input: TaskMoveInput): Promise<TaskCreateResponse>
  reorder(taskIds: string[], positions: number[]): Promise<{ success: boolean; error?: string }>
  duplicate(id: string): Promise<TaskCreateResponse>

  // Subtask operations
  getSubtasks(parentId: string): Promise<Task[]>
  convertToSubtask(taskId: string, parentId: string): Promise<TaskCreateResponse>
  convertToTask(taskId: string): Promise<TaskCreateResponse>

  // Project operations
  createProject(
    input: ProjectCreateInput
  ): Promise<{ success: boolean; project: Project | null; error?: string }>
  getProject(id: string): Promise<ProjectWithStatuses | null>
  updateProject(
    input: ProjectUpdateInput
  ): Promise<{ success: boolean; project: Project | null; error?: string }>
  deleteProject(id: string): Promise<{ success: boolean; error?: string }>
  listProjects(): Promise<ProjectListResponse>
  archiveProject(id: string): Promise<{ success: boolean; error?: string }>
  reorderProjects(
    projectIds: string[],
    positions: number[]
  ): Promise<{ success: boolean; error?: string }>

  // Status operations
  createStatus(
    input: StatusCreateInput
  ): Promise<{ success: boolean; status: Status | null; error?: string }>
  updateStatus(id: string, updates: Partial<Status>): Promise<{ success: boolean; error?: string }>
  deleteStatus(id: string): Promise<{ success: boolean; error?: string }>
  reorderStatuses(
    statusIds: string[],
    positions: number[]
  ): Promise<{ success: boolean; error?: string }>
  listStatuses(projectId: string): Promise<Status[]>

  // Tag operations
  getTags(): Promise<{ tag: string; count: number }[]>

  // Bulk operations
  bulkComplete(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>
  bulkDelete(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>
  bulkMove(
    ids: string[],
    projectId: string
  ): Promise<{ success: boolean; count: number; error?: string }>
  bulkArchive(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>

  // Stats and views
  getStats(): Promise<TaskStats>
  getToday(): Promise<TaskListResponse>
  getUpcoming(days?: number): Promise<TaskListResponse>
  getOverdue(): Promise<TaskListResponse>

  // Note linking
  getLinkedTasks(noteId: string): Promise<Task[]>

  // Development/Testing
  seedPerformanceTest(): Promise<{ success: boolean; message: string }>
  seedDemo(): Promise<{ success: boolean; message: string }>
}

// Advanced search types
export interface AdvancedSearchInput {
  text?: string
  operators?: {
    path?: string
    file?: string
    tags?: string[]
    properties?: { name: string; value: string }[]
  }
  titleOnly?: boolean
  sortBy?: 'relevance' | 'modified' | 'created' | 'title'
  sortDirection?: 'asc' | 'desc'
  folder?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}

export interface AdvancedSearchResultNote extends SearchResultNote {
  emoji?: string | null
}

// Search client API interface
export interface SearchClientAPI {
  query(input: SearchQueryInput): Promise<SearchResponse>
  quick(input: { query: string; limit?: number }): Promise<QuickSearchResponse>
  suggestions(input: { prefix: string; limit?: number }): Promise<SuggestionsResponse>
  getRecent(): Promise<string[]>
  clearRecent(): Promise<void>
  addRecent(query: string): Promise<void>
  getStats(): Promise<SearchStats>
  rebuildIndex(): Promise<void>
  searchNotes(
    query: string,
    options?: { tags?: string[]; limit?: number }
  ): Promise<SearchResultNote[]>
  findByTag(tag: string): Promise<SearchResultNote[]>
  findBacklinks(noteId: string): Promise<SearchResultNote[]>
  advancedSearch(input: AdvancedSearchInput): Promise<AdvancedSearchResultNote[]>
}

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

export interface BookmarkCreatedEvent {
  bookmark: Bookmark
}

export interface BookmarkDeletedEvent {
  id: string
  itemType: string
  itemId: string
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

// Tags client API interface
export interface TagsClientAPI {
  getNotesByTag(input: {
    tag: string
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
  }): Promise<GetNotesByTagResponse>
  pinNoteToTag(input: { noteId: string; tag: string }): Promise<TagOperationResponse>
  unpinNoteFromTag(input: { noteId: string; tag: string }): Promise<TagOperationResponse>
  renameTag(input: { oldName: string; newName: string }): Promise<RenameTagResponse>
  updateTagColor(input: { tag: string; color: string }): Promise<TagOperationResponse>
  deleteTag(tag: string): Promise<DeleteTagResponse>
  removeTagFromNote(input: { noteId: string; tag: string }): Promise<TagOperationResponse>
}

// Inbox types
export type InboxItemType =
  | 'link'
  | 'note'
  | 'image'
  | 'voice'
  | 'video'
  | 'clip'
  | 'pdf'
  | 'social'
  | 'reminder'
export type InboxProcessingStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type InboxFilingAction = 'folder' | 'note' | 'linked'

export interface InboxItem {
  id: string
  type: InboxItemType
  title: string
  content: string | null
  createdAt: Date
  modifiedAt: Date
  filedAt: Date | null
  filedTo: string | null
  filedAction: InboxFilingAction | null
  snoozedUntil: Date | null
  snoozeReason: string | null
  viewedAt: Date | null
  processingStatus: InboxProcessingStatus
  processingError: string | null
  metadata: unknown
  attachmentPath: string | null
  attachmentUrl: string | null
  thumbnailPath: string | null
  thumbnailUrl: string | null
  transcription: string | null
  transcriptionStatus: InboxProcessingStatus | null
  sourceUrl: string | null
  sourceTitle: string | null
  tags: string[]
  isStale: boolean
}

export interface InboxItemListItem {
  id: string
  type: InboxItemType
  title: string
  content: string | null
  createdAt: Date
  thumbnailUrl: string | null
  sourceUrl: string | null
  tags: string[]
  isStale: boolean
  processingStatus: InboxProcessingStatus
  duration?: number
  excerpt?: string
  pageCount?: number
  // Voice transcription fields
  transcription?: string | null
  transcriptionStatus?: InboxProcessingStatus | null
  // Snooze fields (optional - only present for snoozed items)
  snoozedUntil?: Date
  snoozeReason?: string
  // Viewed field (for reminder items)
  viewedAt?: Date
  // Metadata (for reminder items - includes target info)
  metadata?: unknown
}

export interface InboxListResponse {
  items: InboxItemListItem[]
  total: number
  hasMore: boolean
}

export interface InboxCaptureResponse {
  success: boolean
  item: InboxItem | null
  error?: string
}

export interface InboxFileResponse {
  success: boolean
  filedTo: string | null
  noteId?: string
  error?: string
}

export interface InboxBulkResponse {
  success: boolean
  processedCount: number
  errors: Array<{ itemId: string; error: string }>
}

export interface InboxFilingHistoryEntry {
  id: string
  itemId: string
  itemType: InboxItemType
  itemTitle: string
  filedTo: string
  filedAction: InboxFilingAction
  filedAt: Date
  tags: string[]
}

export interface InboxFilingHistoryResponse {
  entries: InboxFilingHistoryEntry[]
}

export interface InboxFilingSuggestion {
  destination: {
    type: 'folder' | 'note' | 'new-note'
    path?: string
    noteId?: string
    noteTitle?: string
  }
  confidence: number
  reason: string
  suggestedTags: string[]
}

export interface InboxSuggestionsResponse {
  suggestions: InboxFilingSuggestion[]
}

export interface InboxStats {
  totalItems: number
  itemsByType: Record<InboxItemType, number>
  staleCount: number
  snoozedCount: number
  processedToday: number
  capturedToday: number
  avgTimeToProcess: number
}

export interface InboxCapturePattern {
  timeHeatmap: number[][]
  typeDistribution: Array<{
    type: InboxItemType
    count: number
    percentage: number
    trend: 'up' | 'down' | 'stable'
  }>
  topDomains: Array<{ domain: string; count: number }>
  topTags: Array<{ tag: string; count: number }>
}

export interface InboxCapturedEvent {
  item: InboxItemListItem
}

export interface InboxUpdatedEvent {
  id: string
  changes: Partial<InboxItem>
}

export interface InboxArchivedEvent {
  id: string
}

export interface InboxFiledEvent {
  id: string
  filedTo: string
  filedAction: string
}

export interface InboxSnoozedEvent {
  id: string
  snoozeUntil: string
}

export interface InboxSnoozeDueEvent {
  items: InboxItemListItem[]
}

export interface InboxTranscriptionCompleteEvent {
  id: string
  transcription: string
}

export interface InboxMetadataCompleteEvent {
  id: string
  metadata: unknown
}

export interface InboxProcessingErrorEvent {
  id: string
  operation: string
  error: string
}

// Inbox client API interface
export interface InboxClientAPI {
  // Capture
  captureText(input: {
    content: string
    title?: string
    tags?: string[]
  }): Promise<InboxCaptureResponse>
  captureLink(input: { url: string; tags?: string[] }): Promise<InboxCaptureResponse>
  captureImage(input: {
    data: ArrayBuffer
    filename: string
    mimeType: string
    tags?: string[]
  }): Promise<InboxCaptureResponse>
  captureVoice(input: {
    data: ArrayBuffer
    duration: number
    format: string
    transcribe?: boolean
    tags?: string[]
  }): Promise<InboxCaptureResponse>
  captureClip(input: {
    html: string
    text: string
    sourceUrl: string
    sourceTitle: string
    tags?: string[]
  }): Promise<InboxCaptureResponse>
  capturePdf(input: {
    data: ArrayBuffer
    filename: string
    extractText?: boolean
    tags?: string[]
  }): Promise<InboxCaptureResponse>

  // CRUD
  get(id: string): Promise<InboxItem | null>
  list(options?: {
    type?: string
    includeSnoozed?: boolean
    sortBy?: 'created' | 'modified' | 'title'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }): Promise<InboxListResponse>
  update(input: { id: string; title?: string; content?: string }): Promise<InboxCaptureResponse>
  archive(id: string): Promise<{ success: boolean; error?: string }>

  // Filing
  file(input: {
    itemId: string
    destination: { type: string; path?: string; noteId?: string; noteTitle?: string }
    tags?: string[]
  }): Promise<InboxFileResponse>
  getSuggestions(itemId: string): Promise<InboxSuggestionsResponse>
  convertToNote(itemId: string): Promise<InboxFileResponse>
  linkToNote(
    itemId: string,
    noteId: string,
    tags?: string[]
  ): Promise<{ success: boolean; error?: string }>
  trackSuggestion(input: {
    itemId: string
    itemType: string
    suggestedTo: string
    actualTo: string
    confidence: number
    suggestedTags?: string[]
    actualTags?: string[]
  }): Promise<{ success: boolean; error?: string }>

  // Tags
  addTag(itemId: string, tag: string): Promise<{ success: boolean; error?: string }>
  removeTag(itemId: string, tag: string): Promise<{ success: boolean; error?: string }>
  getTags(): Promise<Array<{ tag: string; count: number }>>

  // Snooze
  snooze(input: {
    itemId: string
    snoozeUntil: string
    reason?: string
  }): Promise<{ success: boolean; error?: string }>
  unsnooze(itemId: string): Promise<{ success: boolean; error?: string }>
  getSnoozed(): Promise<InboxItem[]>

  // Viewed (for reminder items)
  markViewed(itemId: string): Promise<{ success: boolean; error?: string }>

  // Bulk operations
  bulkFile(input: {
    itemIds: string[]
    destination: { type: string; path?: string; noteId?: string }
    tags?: string[]
  }): Promise<InboxBulkResponse>
  bulkArchive(input: { itemIds: string[] }): Promise<InboxBulkResponse>
  bulkTag(input: { itemIds: string[]; tags: string[] }): Promise<InboxBulkResponse>
  bulkSnooze(input: {
    itemIds: string[]
    snoozeUntil: string
    reason?: string
  }): Promise<InboxBulkResponse>
  fileAllStale(): Promise<InboxBulkResponse>

  // Transcription
  retryTranscription(itemId: string): Promise<{ success: boolean; error?: string }>

  // Metadata
  retryMetadata(itemId: string): Promise<{ success: boolean; error?: string }>

  // Stats
  getStats(): Promise<InboxStats>
  getPatterns(): Promise<InboxCapturePattern>

  // Settings
  getStaleThreshold(): Promise<number>
  setStaleThreshold(days: number): Promise<{ success: boolean }>

  // Archived items
  listArchived(options?: {
    search?: string
    limit?: number
    offset?: number
  }): Promise<InboxListResponse>
  unarchive(id: string): Promise<{ success: boolean; error?: string }>
  deletePermanent(id: string): Promise<{ success: boolean; error?: string }>

  // Filing history
  getFilingHistory(options?: { limit?: number }): Promise<InboxFilingHistoryResponse>
}

// Quick Capture types
export interface QuickCaptureClientAPI {
  /** Close the quick capture window */
  close(): void
  /** Get current clipboard text content */
  getClipboard(): Promise<string>
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

// Reminder types
export type ReminderTargetType = 'note' | 'journal' | 'highlight'
export type ReminderStatus = 'pending' | 'triggered' | 'dismissed' | 'snoozed'

export interface Reminder {
  id: string
  targetType: ReminderTargetType
  targetId: string
  remindAt: string
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
export interface ReminderCreatedEvent {
  reminder: Reminder
}

export interface ReminderUpdatedEvent {
  reminder: Reminder
}

export interface ReminderDeletedEvent {
  id: string
  targetType: string
  targetId: string
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

// Folder View types (Bases-like database view)
export interface FolderViewColumn {
  id: string
  width?: number
  displayName?: string
  showSummary?: boolean
}

export interface FolderViewConfig {
  path: string
  template?: string
  inherit?: boolean
  views?: FolderViewView[]
  formulas?: Record<string, string>
  properties?: Record<string, unknown>
  summaries?: Record<string, unknown>
}

export interface FolderViewGroupBy {
  property: string
  direction?: 'asc' | 'desc'
  collapsed?: boolean
  showSummary?: boolean
}

export interface FolderViewView {
  name: string
  type: 'table' | 'grid' | 'list' | 'kanban'
  default?: boolean
  columns?: FolderViewColumn[]
  filters?: unknown
  order?: Array<{ property: string; direction: 'asc' | 'desc' }>
  groupBy?: FolderViewGroupBy
  limit?: number
  showSummaries?: boolean
}

export interface FolderViewNote {
  id: string
  path: string
  title: string
  emoji: string | null
  folder: string
  tags: string[]
  created: string
  modified: string
  wordCount: number
  properties: Record<string, unknown>
}

export interface FolderViewAvailableProperty {
  name: string
  type: string
  usageCount: number
}

export interface FolderViewGetConfigResponse {
  config: FolderViewConfig
  isDefault: boolean
}

export interface FolderViewGetViewsResponse {
  views: FolderViewView[]
  defaultIndex: number
}

export interface FolderViewListResponse {
  notes: FolderViewNote[]
  total: number
  hasMore: boolean
}

export interface FolderViewAvailablePropertiesResponse {
  builtIn: Array<{ id: string; displayName: string; type: string }>
  properties: FolderViewAvailableProperty[]
  formulas: Array<{ id: string; expression: string }>
}

export interface FolderViewConfigUpdatedEvent {
  path: string
  source: 'internal' | 'external'
}

// Folder Suggestion types (Phase 27)
export interface FolderSuggestion {
  path: string
  confidence: number
  reason: string
}

export interface FolderViewGetFolderSuggestionsResponse {
  suggestions: FolderSuggestion[]
}

// Folder View client API interface
export interface FolderViewClientAPI {
  getConfig(folderPath: string): Promise<FolderViewGetConfigResponse>
  setConfig(
    folderPath: string,
    config: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }>
  getViews(folderPath: string): Promise<FolderViewGetViewsResponse>
  setView(
    folderPath: string,
    view: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }>
  deleteView(folderPath: string, viewName: string): Promise<{ success: boolean; error?: string }>
  listWithProperties(options: {
    folderPath: string
    properties?: string[]
    limit?: number
    offset?: number
  }): Promise<FolderViewListResponse>
  getAvailableProperties(folderPath: string): Promise<FolderViewAvailablePropertiesResponse>
  /** Get AI-powered folder suggestions for moving a note (Phase 27) */
  getFolderSuggestions(noteId: string): Promise<FolderViewGetFolderSuggestionsResponse>
  /** Check if a folder exists (T115) */
  folderExists(folderPath: string): Promise<boolean>
}

// Tab Settings types
export interface TabSettings {
  /** Single-click opens preview, double-click opens permanent */
  previewMode: boolean
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
    needsRecoverySetup?: boolean
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
  refreshToken: () => Promise<{
    success: boolean
    error?: string
  }>
}

// Sync Setup API
interface SyncSetupClientAPI {
  setupFirstDevice: (input: { provider: 'google'; oauthToken: string; state: string }) => Promise<{
    success: boolean
    recoveryPhrase?: string
    deviceId?: string
    error?: string
  }>
  confirmRecoveryPhrase: (input: { confirmed: boolean }) => Promise<{
    success: boolean
  }>
}

// Device Linking API
interface SyncLinkingClientAPI {
  generateLinkingQr: () => Promise<{
    sessionId?: string
    qrData?: string
    expiresAt?: number
  }>
  linkViaQr: (input: { qrData: string; provider: string; oauthToken: string }) => Promise<{
    success: boolean
    status?: 'waiting_approval' | 'approved' | 'error'
    error?: string
  }>
  linkViaRecovery: (input: {
    recoveryPhrase: string
    provider: string
    oauthToken: string
  }) => Promise<{
    success: boolean
    error?: string
  }>
  approveLinking: (input: { sessionId: string }) => Promise<{
    success: boolean
    error?: string
  }>
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
  rotateKeys: (input: { confirm: boolean }) => Promise<{
    success: boolean
    newRecoveryPhrase?: string
    error?: string
  }>
  getRotationProgress: () => Promise<{
    inProgress: boolean
    phase?: string
    processedItems?: number
    totalItems?: number
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

// Full API interface
interface API extends WindowAPI {
  vault: VaultClientAPI
  notes: NotesClientAPI
  properties: PropertiesClientAPI
  search: SearchClientAPI
  tasks: TasksClientAPI
  savedFilters: SavedFiltersClientAPI
  templates: TemplatesClientAPI
  journal: JournalClientAPI
  settings: SettingsClientAPI
  bookmarks: BookmarksClientAPI
  tags: TagsClientAPI
  inbox: InboxClientAPI
  reminders: RemindersClientAPI
  quickCapture: QuickCaptureClientAPI
  folderView: FolderViewClientAPI
  syncAuth: SyncAuthClientAPI
  syncSetup: SyncSetupClientAPI
  syncLinking: SyncLinkingClientAPI
  syncDevices: SyncDevicesClientAPI
  syncOps: SyncOpsClientAPI
  crypto: CryptoClientAPI
  syncAttachments: SyncAttachmentsClientAPI
  /** Show a native OS context menu and return the selected item id, or null if dismissed */
  showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>
  // Vault event subscriptions
  onVaultStatusChanged: (callback: (status: VaultStatus) => void) => () => void
  onVaultIndexProgress: (callback: (progress: number) => void) => () => void
  onVaultError: (callback: (error: string) => void) => () => void
  onVaultIndexRecovered: (callback: (event: IndexRecoveredEvent) => void) => () => void
  // Notes event subscriptions
  onNoteCreated: (callback: (event: NoteCreatedEvent) => void) => () => void
  onNoteUpdated: (callback: (event: NoteUpdatedEvent) => void) => () => void
  onNoteDeleted: (callback: (event: NoteDeletedEvent) => void) => () => void
  onNoteRenamed: (callback: (event: NoteRenamedEvent) => void) => () => void
  onNoteMoved: (callback: (event: NoteMovedEvent) => void) => () => void
  onNoteExternalChange: (callback: (event: NoteExternalChangeEvent) => void) => () => void
  onTagsChanged: (callback: () => void) => () => void
  // Search event subscriptions
  onSearchIndexRebuildStarted: (callback: () => void) => () => void
  onSearchIndexRebuildProgress: (
    callback: (progress: IndexRebuildProgressEvent) => void
  ) => () => void
  onSearchIndexRebuildCompleted: (
    callback: (result: IndexRebuildCompletedEvent) => void
  ) => () => void
  onSearchIndexCorrupt: (callback: () => void) => () => void
  // Tasks event subscriptions
  onTaskCreated: (callback: (event: TaskCreatedEvent) => void) => () => void
  onTaskUpdated: (callback: (event: TaskUpdatedEvent) => void) => () => void
  onTaskDeleted: (callback: (event: TaskDeletedEvent) => void) => () => void
  onTaskCompleted: (callback: (event: TaskCompletedEvent) => void) => () => void
  onTaskMoved: (callback: (event: TaskMovedEvent) => void) => () => void
  onProjectCreated: (callback: (event: ProjectCreatedEvent) => void) => () => void
  onProjectUpdated: (callback: (event: ProjectUpdatedEvent) => void) => () => void
  onProjectDeleted: (callback: (event: ProjectDeletedEvent) => void) => () => void
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
  // Settings event subscriptions
  onSettingsChanged: (callback: (event: SettingsChangedEvent) => void) => () => void
  onEmbeddingProgress: (callback: (event: EmbeddingProgressEvent) => void) => () => void
  // Bookmarks event subscriptions
  onBookmarkCreated: (callback: (event: BookmarkCreatedEvent) => void) => () => void
  onBookmarkDeleted: (callback: (event: BookmarkDeletedEvent) => void) => () => void
  onBookmarksReordered: (callback: (event: BookmarksReorderedEvent) => void) => () => void
  // Tags event subscriptions
  onTagRenamed: (callback: (event: TagRenamedEvent) => void) => () => void
  onTagColorUpdated: (callback: (event: TagColorUpdatedEvent) => void) => () => void
  onTagDeleted: (callback: (event: TagDeletedEvent) => void) => () => void
  onTagNotesChanged: (callback: (event: TagNotesChangedEvent) => void) => () => void
  // Inbox event subscriptions
  onInboxCaptured: (callback: (event: { item: unknown }) => void) => () => void
  onInboxUpdated: (callback: (event: { id: string; changes: unknown }) => void) => () => void
  onInboxArchived: (callback: (event: { id: string }) => void) => () => void
  onInboxFiled: (
    callback: (event: { id: string; filedTo: string; filedAction: string }) => void
  ) => () => void
  onInboxSnoozed: (callback: (event: { id: string; snoozeUntil: string }) => void) => () => void
  onInboxSnoozeDue: (callback: (event: { items: unknown[] }) => void) => () => void
  onInboxTranscriptionComplete: (
    callback: (event: { id: string; transcription: string }) => void
  ) => () => void
  onInboxMetadataComplete: (
    callback: (event: { id: string; metadata: unknown }) => void
  ) => () => void
  onInboxProcessingError: (
    callback: (event: { id: string; operation: string; error: string }) => void
  ) => () => void
  // Reminder event subscriptions
  onReminderCreated: (callback: (event: ReminderCreatedEvent) => void) => () => void
  onReminderUpdated: (callback: (event: ReminderUpdatedEvent) => void) => () => void
  onReminderDeleted: (callback: (event: ReminderDeletedEvent) => void) => () => void
  onReminderDue: (callback: (event: ReminderDueEvent) => void) => () => void
  onReminderDismissed: (callback: (event: ReminderDismissedEvent) => void) => () => void
  onReminderSnoozed: (callback: (event: ReminderSnoozedEvent) => void) => () => void
  onReminderClicked: (callback: (event: ReminderClickedEvent) => void) => () => void
  // Folder View event subscriptions
  onFolderViewConfigUpdated: (callback: (event: FolderViewConfigUpdatedEvent) => void) => () => void
  // Sync event subscriptions
  onSyncStatusChanged: (callback: (event: SyncStatusChangedEvent) => void) => () => void
  onItemSynced: (callback: (event: ItemSyncedEvent) => void) => () => void
  onConflictDetected: (callback: (event: ConflictDetectedEvent) => void) => () => void
  onLinkingRequest: (callback: (event: LinkingRequestEvent) => void) => () => void
  onLinkingApproved: (callback: (event: LinkingApprovedEvent) => void) => () => void
  onUploadProgress: (callback: (event: UploadProgressEvent) => void) => () => void
  onDownloadProgress: (callback: (event: DownloadProgressEvent) => void) => () => void
  onInitialSyncProgress: (callback: (event: InitialSyncProgressEvent) => void) => () => void
  onQueueCleared: (callback: (event: QueueClearedEvent) => void) => () => void
  onSyncPaused: (callback: (event: SyncPausedEvent) => void) => () => void
  onSyncResumed: (callback: (event: SyncResumedEvent) => void) => () => void
  onKeyRotationProgress: (callback: (event: KeyRotationProgressEvent) => void) => () => void
  onSessionExpired: (callback: (event: SessionExpiredEvent) => void) => () => void
  onOtpDetected: (callback: (event: OtpDetectedEvent) => void) => () => void
  onOAuthCallback: (callback: (event: OAuthCallbackEvent) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: API
  }
}

export {}
