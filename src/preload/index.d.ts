import { ElectronAPI } from '@electron-toolkit/preload'

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
  update(input: NoteUpdateInput): Promise<NoteUpdateResponse>
  rename(id: string, newTitle: string): Promise<NoteUpdateResponse>
  move(id: string, newFolder: string): Promise<NoteUpdateResponse>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  list(options?: NoteListOptions): Promise<NoteListResponse>
  getTags(): Promise<{ tag: string; count: number }[]>
  getLinks(id: string): Promise<NoteLinksResponse>
  getFolders(): Promise<string[]>
  createFolder(path: string): Promise<{ success: boolean; error?: string }>
  renameFolder(oldPath: string, newPath: string): Promise<{ success: boolean; error?: string }>
  deleteFolder(path: string): Promise<{ success: boolean; error?: string }>
  exists(titleOrPath: string): Promise<boolean>
  openExternal(id: string): Promise<void>
  revealInFinder(id: string): Promise<void>
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
  createProject(input: ProjectCreateInput): Promise<{ success: boolean; project: Project | null; error?: string }>
  getProject(id: string): Promise<ProjectWithStatuses | null>
  updateProject(input: ProjectUpdateInput): Promise<{ success: boolean; project: Project | null; error?: string }>
  deleteProject(id: string): Promise<{ success: boolean; error?: string }>
  listProjects(): Promise<ProjectListResponse>
  archiveProject(id: string): Promise<{ success: boolean; error?: string }>
  reorderProjects(projectIds: string[], positions: number[]): Promise<{ success: boolean; error?: string }>

  // Status operations
  createStatus(input: StatusCreateInput): Promise<{ success: boolean; status: Status | null; error?: string }>
  updateStatus(id: string, updates: Partial<Status>): Promise<{ success: boolean; error?: string }>
  deleteStatus(id: string): Promise<{ success: boolean; error?: string }>
  reorderStatuses(statusIds: string[], positions: number[]): Promise<{ success: boolean; error?: string }>
  listStatuses(projectId: string): Promise<Status[]>

  // Tag operations
  getTags(): Promise<{ tag: string; count: number }[]>

  // Bulk operations
  bulkComplete(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>
  bulkDelete(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>
  bulkMove(ids: string[], projectId: string): Promise<{ success: boolean; count: number; error?: string }>
  bulkArchive(ids: string[]): Promise<{ success: boolean; count: number; error?: string }>

  // Stats and views
  getStats(): Promise<TaskStats>
  getToday(): Promise<TaskListResponse>
  getUpcoming(days?: number): Promise<TaskListResponse>
  getOverdue(): Promise<TaskListResponse>
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
  searchNotes(query: string, options?: { tags?: string[]; limit?: number }): Promise<SearchResultNote[]>
  findByTag(tag: string): Promise<SearchResultNote[]>
  findBacklinks(noteId: string): Promise<SearchResultNote[]>
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
  search: SearchClientAPI
  tasks: TasksClientAPI
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
  // Search event subscriptions
  onSearchIndexRebuildStarted: (callback: () => void) => () => void
  onSearchIndexRebuildProgress: (callback: (progress: IndexRebuildProgressEvent) => void) => () => void
  onSearchIndexRebuildCompleted: (callback: (result: IndexRebuildCompletedEvent) => void) => () => void
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
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: API
  }
}

export {}
