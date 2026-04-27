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
  properties: Record<string, unknown>
  emoji?: string | null
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
  emoji?: string | null
  localOnly?: boolean
  fileType?: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
  mimeType?: string | null
  fileSize?: number | null
}

export interface FileMetadata {
  id: string
  path: string
  absolutePath: string
  title: string
  fileType: 'pdf' | 'image' | 'audio' | 'video'
  mimeType: string | null
  fileSize: number | null
  created: Date
  modified: Date
}

export interface WikiLinkResolution {
  id: string
  path: string
  title: string
  fileType: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
}

export interface WikiLinkPreview {
  id: string
  title: string
  emoji: string | null
  snippet: string | null
  tags: Array<{ name: string; color: string }>
  createdAt: string
}

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

export interface SelectOption {
  value: string
  color: string
  default?: boolean
}

export type StatusCategoryKey = 'todo' | 'in_progress' | 'done'
export type EditablePropertyType = PropertyType
export type EnsurablePropertyType = Extract<PropertyType, 'select' | 'multiselect' | 'status'>

export interface PropertyDefinition {
  name: string
  type: PropertyType
  options: string | null
  defaultValue: string | null
  color: string | null
  createdAt: string
}

export interface CreatePropertyDefinitionInput {
  name: string
  type: EditablePropertyType
  options?: SelectOption[]
  defaultValue?: unknown
  color?: string
}

export interface UpdatePropertyDefinitionInput {
  name: string
  type?: EditablePropertyType
  options?: SelectOption[]
  defaultValue?: unknown
  color?: string
}

export interface CreatePropertyDefinitionResponse {
  success: boolean
  definition: PropertyDefinition | null
  error?: string
}

export interface AttachmentResult {
  success: boolean
  path?: string
  name?: string
  size?: number
  mimeType?: string
  type?: 'image' | 'file'
  error?: string
}

export interface AttachmentInfo {
  filename: string
  path: string
  size: number
  mimeType: string
  type: 'image' | 'file'
}

export interface AttachmentUploadFile {
  name: string
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface DeleteAttachmentResponse {
  success: boolean
  error?: string
}

export interface FolderConfig {
  icon?: string | null
  template?: string
  inherit?: boolean
}

export interface FolderInfo {
  path: string
  icon?: string | null
}

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
  fileContent: string
}

export interface RestoreVersionResponse {
  success: boolean
  note: Note | null
  error?: string
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
  emoji?: string | null
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
}

export interface BacklinkContext {
  snippet: string
  linkStart: number
  linkEnd: number
}

export interface Backlink {
  sourceId: string
  sourcePath: string
  sourceTitle: string
  contexts: BacklinkContext[]
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

export interface ImportFilesResponse {
  success: boolean
  imported: number
  failed: number
  errors: string[]
  importedFiles: Array<{ destPath: string; filename: string; fileType: string }>
}

export interface ImportDialogResponse {
  canceled: boolean
  filePaths: string[]
}

export interface NotePositionsResponse {
  success: boolean
  positions: Record<string, number>
  error?: string
}

type SuccessResponse = Promise<{ success: boolean; error?: string }>

export interface NotesClientAPI {
  create(input: NoteCreateInput): Promise<NoteCreateResponse>
  get(id: string): Promise<Note | null>
  getByPath(path: string): Promise<Note | null>
  getFile(id: string): Promise<FileMetadata | null>
  resolveByTitle(title: string): Promise<WikiLinkResolution | null>
  previewByTitle(title: string): Promise<WikiLinkPreview | null>
  update(input: NoteUpdateInput): Promise<NoteUpdateResponse>
  rename(id: string, newTitle: string): Promise<NoteUpdateResponse>
  move(id: string, newFolder: string): Promise<NoteUpdateResponse>
  delete(id: string): SuccessResponse
  list(options?: NoteListOptions): Promise<NoteListResponse>
  getTags(): Promise<Array<{ tag: string; color: string; count: number }>>
  getLinks(id: string): Promise<NoteLinksResponse>
  getFolders(): Promise<FolderInfo[]>
  createFolder(path: string): Promise<{ success: boolean }>
  renameFolder(oldPath: string, newPath: string): Promise<{ success: boolean }>
  deleteFolder(path: string): SuccessResponse
  exists(titleOrPath: string): Promise<boolean>
  openExternal(id: string): Promise<void>
  revealInFinder(id: string): Promise<void>
  getPropertyDefinitions(): Promise<PropertyDefinition[]>
  createPropertyDefinition(
    input: CreatePropertyDefinitionInput
  ): Promise<CreatePropertyDefinitionResponse>
  updatePropertyDefinition(
    input: UpdatePropertyDefinitionInput
  ): Promise<CreatePropertyDefinitionResponse>
  ensurePropertyDefinition(
    name: string,
    type: EnsurablePropertyType
  ): Promise<{ success: boolean }>
  addPropertyOption(propertyName: string, option: SelectOption): Promise<{ success: boolean }>
  addStatusOption(
    propertyName: string,
    categoryKey: StatusCategoryKey,
    option: SelectOption
  ): Promise<{ success: boolean }>
  removePropertyOption(propertyName: string, optionValue: string): Promise<{ success: boolean }>
  renamePropertyOption(
    propertyName: string,
    oldValue: string,
    newValue: string
  ): Promise<{ success: boolean }>
  updateOptionColor(
    propertyName: string,
    optionValue: string,
    newColor: string
  ): Promise<{ success: boolean }>
  deletePropertyDefinition(name: string): Promise<{ success: boolean }>
  uploadAttachment(noteId: string, file: AttachmentUploadFile): Promise<AttachmentResult>
  listAttachments(noteId: string): Promise<AttachmentInfo[]>
  deleteAttachment(noteId: string, filename: string): Promise<DeleteAttachmentResponse>
  getFolderConfig(folderPath: string): Promise<FolderConfig | null>
  setFolderConfig(
    folderPath: string,
    config: FolderConfig
  ): Promise<{ success: boolean; error?: string }>
  getFolderTemplate(folderPath: string): Promise<string | null>
  exportPdf(input: ExportNoteInput): Promise<ExportNoteResponse>
  exportHtml(input: ExportNoteInput): Promise<ExportNoteResponse>
  getVersions(noteId: string): Promise<SnapshotListItem[]>
  getVersion(snapshotId: string): Promise<SnapshotDetail | null>
  restoreVersion(snapshotId: string): Promise<RestoreVersionResponse>
  deleteVersion(snapshotId: string): SuccessResponse
  getPositions(folderPath: string): Promise<NotePositionsResponse>
  getAllPositions(): Promise<{
    success: boolean
    positions: Record<string, number>
    error?: string
  }>
  reorder(folderPath: string, notePaths: string[]): Promise<{ success: boolean; error?: string }>
  importFiles(sourcePaths: string[], targetFolder?: string): Promise<ImportFilesResponse>
  showImportDialog(): Promise<ImportDialogResponse>
  setLocalOnly(
    id: string,
    localOnly: boolean
  ): Promise<{ success: boolean; note: Note | null; error?: string }>
  getLocalOnlyCount(): Promise<{ count: number }>
}
