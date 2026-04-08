import { NotesChannels } from '@memry/contracts/ipc-channels'
import { defineDomain, defineEvent, defineMethod, type RpcClient, type RpcSubscriptions } from './schema'

interface NoteFrontmatter {
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

type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'status'
  | 'url'
  | 'rating'

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

type SnapshotReason = 'manual' | 'auto' | 'timer' | 'significant'

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

export const notesRpc = defineDomain({
  name: 'notes',
  methods: {
    create: defineMethod<(input: NoteCreateInput) => Promise<NoteCreateResponse>>({
      channel: NotesChannels.invoke.CREATE,
      params: ['input']
    }),
    get: defineMethod<(id: string) => Promise<Note | null>>({
      channel: NotesChannels.invoke.GET,
      params: ['id']
    }),
    getByPath: defineMethod<(path: string) => Promise<Note | null>>({
      channel: NotesChannels.invoke.GET_BY_PATH,
      params: ['path']
    }),
    getFile: defineMethod<(id: string) => Promise<FileMetadata | null>>({
      channel: NotesChannels.invoke.GET_FILE,
      params: ['id']
    }),
    resolveByTitle: defineMethod<(title: string) => Promise<WikiLinkResolution | null>>({
      channel: NotesChannels.invoke.RESOLVE_BY_TITLE,
      params: ['title']
    }),
    previewByTitle: defineMethod<(title: string) => Promise<WikiLinkPreview | null>>({
      channel: NotesChannels.invoke.PREVIEW_BY_TITLE,
      params: ['title']
    }),
    update: defineMethod<(input: NoteUpdateInput) => Promise<NoteUpdateResponse>>({
      channel: NotesChannels.invoke.UPDATE,
      params: ['input']
    }),
    rename: defineMethod<(id: string, newTitle: string) => Promise<NoteUpdateResponse>>({
      channel: NotesChannels.invoke.RENAME,
      params: ['id', 'newTitle'],
      invokeArgs: ['{ id, newTitle }']
    }),
    move: defineMethod<(id: string, newFolder: string) => Promise<NoteUpdateResponse>>({
      channel: NotesChannels.invoke.MOVE,
      params: ['id', 'newFolder'],
      invokeArgs: ['{ id, newFolder }']
    }),
    delete: defineMethod<(id: string) => SuccessResponse>({
      channel: NotesChannels.invoke.DELETE,
      params: ['id']
    }),
    list: defineMethod<(options?: NoteListOptions) => Promise<NoteListResponse>>({
      channel: NotesChannels.invoke.LIST,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    getTags: defineMethod<() => Promise<Array<{ tag: string; color: string; count: number }>>>({
      channel: NotesChannels.invoke.GET_TAGS
    }),
    getLinks: defineMethod<(id: string) => Promise<NoteLinksResponse>>({
      channel: NotesChannels.invoke.GET_LINKS,
      params: ['id']
    }),
    getFolders: defineMethod<() => Promise<FolderInfo[]>>({
      channel: NotesChannels.invoke.GET_FOLDERS
    }),
    createFolder: defineMethod<(path: string) => Promise<{ success: boolean }>>({
      channel: NotesChannels.invoke.CREATE_FOLDER,
      params: ['path']
    }),
    renameFolder: defineMethod<(oldPath: string, newPath: string) => Promise<{ success: boolean }>>(
      {
        channel: NotesChannels.invoke.RENAME_FOLDER,
        params: ['oldPath', 'newPath'],
        invokeArgs: ['{ oldPath, newPath }']
      }
    ),
    deleteFolder: defineMethod<(path: string) => SuccessResponse>({
      channel: NotesChannels.invoke.DELETE_FOLDER,
      params: ['path']
    }),
    exists: defineMethod<(titleOrPath: string) => Promise<boolean>>({
      channel: NotesChannels.invoke.EXISTS,
      params: ['titleOrPath']
    }),
    openExternal: defineMethod<(id: string) => Promise<void>>({
      channel: NotesChannels.invoke.OPEN_EXTERNAL,
      params: ['id']
    }),
    revealInFinder: defineMethod<(id: string) => Promise<void>>({
      channel: NotesChannels.invoke.REVEAL_IN_FINDER,
      params: ['id']
    }),
    getPropertyDefinitions: defineMethod<() => Promise<PropertyDefinition[]>>({
      channel: NotesChannels.invoke.GET_PROPERTY_DEFINITIONS
    }),
    createPropertyDefinition: defineMethod<
      (input: CreatePropertyDefinitionInput) => Promise<CreatePropertyDefinitionResponse>
    >({
      channel: NotesChannels.invoke.CREATE_PROPERTY_DEFINITION,
      params: ['input']
    }),
    updatePropertyDefinition: defineMethod<
      (input: UpdatePropertyDefinitionInput) => Promise<CreatePropertyDefinitionResponse>
    >({
      channel: NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION,
      params: ['input']
    }),
    ensurePropertyDefinition: defineMethod<(name: string, type: string) => Promise<{ success: boolean }>>(
      {
        channel: NotesChannels.invoke.ENSURE_PROPERTY_DEFINITION,
        params: ['name', 'type'],
        invokeArgs: ['{ name, type }']
      }
    ),
    addPropertyOption: defineMethod<
      (propertyName: string, option: { value: string; color: string }) => Promise<{ success: boolean }>
    >({
      channel: NotesChannels.invoke.ADD_PROPERTY_OPTION,
      params: ['propertyName', 'option'],
      invokeArgs: ['{ propertyName, option }']
    }),
    addStatusOption: defineMethod<
      (
        propertyName: string,
        categoryKey: string,
        option: { value: string; color: string }
      ) => Promise<{ success: boolean }>
    >({
      channel: NotesChannels.invoke.ADD_STATUS_OPTION,
      params: ['propertyName', 'categoryKey', 'option'],
      invokeArgs: ['{ propertyName, categoryKey, option }']
    }),
    removePropertyOption: defineMethod<
      (propertyName: string, optionValue: string) => Promise<{ success: boolean }>
    >({
      channel: NotesChannels.invoke.REMOVE_PROPERTY_OPTION,
      params: ['propertyName', 'optionValue'],
      invokeArgs: ['{ propertyName, optionValue }']
    }),
    renamePropertyOption: defineMethod<
      (propertyName: string, oldValue: string, newValue: string) => Promise<{ success: boolean }>
    >({
      channel: NotesChannels.invoke.RENAME_PROPERTY_OPTION,
      params: ['propertyName', 'oldValue', 'newValue'],
      invokeArgs: ['{ propertyName, oldValue, newValue }']
    }),
    updateOptionColor: defineMethod<
      (propertyName: string, optionValue: string, newColor: string) => Promise<{ success: boolean }>
    >({
      channel: NotesChannels.invoke.UPDATE_OPTION_COLOR,
      params: ['propertyName', 'optionValue', 'newColor'],
      invokeArgs: ['{ propertyName, optionValue, newColor }']
    }),
    deletePropertyDefinition: defineMethod<(name: string) => Promise<{ success: boolean }>>({
      channel: NotesChannels.invoke.DELETE_PROPERTY_DEFINITION,
      params: ['name']
    }),
    uploadAttachment: defineMethod<
      (noteId: string, file: AttachmentUploadFile) => Promise<AttachmentResult>
    >({
      channel: NotesChannels.invoke.UPLOAD_ATTACHMENT,
      params: ['noteId', 'file'],
      implementation: `async (noteId, file) =>
        invoke(${JSON.stringify(NotesChannels.invoke.UPLOAD_ATTACHMENT)}, {
          noteId,
          filename: file.name,
          data: Array.from(new Uint8Array(await file.arrayBuffer()))
        })`
    }),
    listAttachments: defineMethod<(noteId: string) => Promise<AttachmentInfo[]>>({
      channel: NotesChannels.invoke.LIST_ATTACHMENTS,
      params: ['noteId']
    }),
    deleteAttachment: defineMethod<
      (noteId: string, filename: string) => Promise<DeleteAttachmentResponse>
    >({
      channel: NotesChannels.invoke.DELETE_ATTACHMENT,
      params: ['noteId', 'filename'],
      invokeArgs: ['{ noteId, filename }']
    }),
    getFolderConfig: defineMethod<(folderPath: string) => Promise<FolderConfig | null>>({
      channel: NotesChannels.invoke.GET_FOLDER_CONFIG,
      params: ['folderPath']
    }),
    setFolderConfig: defineMethod<
      (folderPath: string, config: FolderConfig) => Promise<{ success: boolean; error?: string }>
    >({
      channel: NotesChannels.invoke.SET_FOLDER_CONFIG,
      params: ['folderPath', 'config'],
      invokeArgs: ['{ folderPath, config }']
    }),
    getFolderTemplate: defineMethod<(folderPath: string) => Promise<string | null>>({
      channel: NotesChannels.invoke.GET_FOLDER_TEMPLATE,
      params: ['folderPath']
    }),
    exportPdf: defineMethod<(input: ExportNoteInput) => Promise<ExportNoteResponse>>({
      channel: NotesChannels.invoke.EXPORT_PDF,
      params: ['input']
    }),
    exportHtml: defineMethod<(input: ExportNoteInput) => Promise<ExportNoteResponse>>({
      channel: NotesChannels.invoke.EXPORT_HTML,
      params: ['input']
    }),
    getVersions: defineMethod<(noteId: string) => Promise<SnapshotListItem[]>>({
      channel: NotesChannels.invoke.GET_VERSIONS,
      params: ['noteId']
    }),
    getVersion: defineMethod<(snapshotId: string) => Promise<SnapshotDetail | null>>({
      channel: NotesChannels.invoke.GET_VERSION,
      params: ['snapshotId']
    }),
    restoreVersion: defineMethod<(snapshotId: string) => Promise<RestoreVersionResponse>>({
      channel: NotesChannels.invoke.RESTORE_VERSION,
      params: ['snapshotId']
    }),
    deleteVersion: defineMethod<(snapshotId: string) => SuccessResponse>({
      channel: NotesChannels.invoke.DELETE_VERSION,
      params: ['snapshotId']
    }),
    getPositions: defineMethod<(folderPath: string) => Promise<NotePositionsResponse>>({
      channel: NotesChannels.invoke.GET_POSITIONS,
      params: ['folderPath'],
      invokeArgs: ['{ folderPath }']
    }),
    getAllPositions: defineMethod<
      () => Promise<{ success: boolean; positions: Record<string, number>; error?: string }>
    >({
      channel: NotesChannels.invoke.GET_ALL_POSITIONS
    }),
    reorder: defineMethod<
      (folderPath: string, notePaths: string[]) => Promise<{ success: boolean; error?: string }>
    >({
      channel: NotesChannels.invoke.REORDER,
      params: ['folderPath', 'notePaths'],
      invokeArgs: ['{ folderPath, notePaths }']
    }),
    importFiles: defineMethod<
      (sourcePaths: string[], targetFolder?: string) => Promise<ImportFilesResponse>
    >({
      channel: NotesChannels.invoke.IMPORT_FILES,
      params: ['sourcePaths', 'targetFolder'],
      invokeArgs: ['{ sourcePaths, targetFolder }']
    }),
    showImportDialog: defineMethod<() => Promise<ImportDialogResponse>>({
      channel: NotesChannels.invoke.SHOW_IMPORT_DIALOG
    }),
    setLocalOnly: defineMethod<
      (id: string, localOnly: boolean) => Promise<{ success: boolean; note: Note | null; error?: string }>
    >({
      channel: NotesChannels.invoke.SET_LOCAL_ONLY,
      params: ['id', 'localOnly'],
      invokeArgs: ['{ id, localOnly }']
    }),
    getLocalOnlyCount: defineMethod<() => Promise<{ count: number }>>({
      channel: NotesChannels.invoke.GET_LOCAL_ONLY_COUNT
    })
  },
  events: {
    onNoteCreated: defineEvent<NoteCreatedEvent>(NotesChannels.events.CREATED),
    onNoteUpdated: defineEvent<NoteUpdatedEvent>(NotesChannels.events.UPDATED),
    onNoteDeleted: defineEvent<NoteDeletedEvent>(NotesChannels.events.DELETED),
    onNoteRenamed: defineEvent<NoteRenamedEvent>(NotesChannels.events.RENAMED),
    onNoteMoved: defineEvent<NoteMovedEvent>(NotesChannels.events.MOVED),
    onNoteExternalChange: defineEvent<NoteExternalChangeEvent>(NotesChannels.events.EXTERNAL_CHANGE),
    onTagsChanged: defineEvent<void>('notes:tags-changed')
  }
})

export type NotesClientAPI = RpcClient<typeof notesRpc>
export type NotesSubscriptions = RpcSubscriptions<typeof notesRpc>
