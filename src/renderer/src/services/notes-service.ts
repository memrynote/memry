import type {
  NotesClientAPI,
  Note,
  NoteListItem,
  NoteCreateResponse,
  NoteUpdateResponse,
  NoteListResponse,
  NoteLinksResponse,
  NoteCreatedEvent,
  NoteUpdatedEvent,
  NoteDeletedEvent,
  NoteRenamedEvent,
  NoteMovedEvent,
  NoteExternalChangeEvent,
  PropertyValue,
  PropertyDefinition,
  SetPropertiesResponse,
  CreatePropertyDefinitionInput,
  CreatePropertyDefinitionResponse,
  UpdatePropertyDefinitionInput,
  AttachmentResult,
  AttachmentInfo,
  DeleteAttachmentResponse,
  FolderConfig,
  ExportNoteInput,
  ExportNoteResponse,
  // Version history types (T114)
  SnapshotListItem,
  SnapshotDetail,
  RestoreVersionResponse
} from '../../../preload/index.d'

/**
 * Notes service - thin wrapper around window.api.notes
 * Provides a typed interface for note operations in the renderer process.
 */
export const notesService: NotesClientAPI = {
  /**
   * Create a new note.
   */
  create: (input: {
    title: string
    content?: string
    folder?: string
    tags?: string[]
    template?: string
  }): Promise<NoteCreateResponse> => {
    return window.api.notes.create(input)
  },

  /**
   * Get a note by ID.
   */
  get: (id: string): Promise<Note | null> => {
    return window.api.notes.get(id)
  },

  /**
   * Get a note by path.
   */
  getByPath: (path: string): Promise<Note | null> => {
    return window.api.notes.getByPath(path)
  },

  /**
   * Get file metadata by ID (for non-markdown files).
   */
  getFile: (id: string) => {
    return window.api.notes.getFile(id)
  },

  /**
   * Resolve a WikiLink target by title.
   * Returns metadata for format-aware WikiLink handling.
   * Used to determine whether to open a note editor or file viewer.
   */
  resolveByTitle: (title: string) => {
    return window.api.notes.resolveByTitle(title)
  },

  /**
   * Update an existing note.
   */
  update: (input: {
    id: string
    title?: string
    content?: string
    tags?: string[]
    frontmatter?: Record<string, unknown>
    emoji?: string | null // T028: Emoji support
  }): Promise<NoteUpdateResponse> => {
    return window.api.notes.update(input)
  },

  /**
   * Rename a note (changes title and filename).
   */
  rename: (id: string, newTitle: string): Promise<NoteUpdateResponse> => {
    return window.api.notes.rename(id, newTitle)
  },

  /**
   * Move a note to a different folder.
   */
  move: (id: string, newFolder: string): Promise<NoteUpdateResponse> => {
    return window.api.notes.move(id, newFolder)
  },

  /**
   * Delete a note.
   */
  delete: (id: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.notes.delete(id)
  },

  /**
   * List notes with filtering and pagination.
   */
  list: (options?: {
    folder?: string
    tags?: string[]
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }): Promise<NoteListResponse> => {
    return window.api.notes.list(options)
  },

  /**
   * Get all tags with their usage counts and colors.
   */
  getTags: (): Promise<{ tag: string; color: string; count: number }[]> => {
    return window.api.notes.getTags()
  },

  /**
   * Get outgoing and incoming links for a note.
   */
  getLinks: (id: string): Promise<NoteLinksResponse> => {
    return window.api.notes.getLinks(id)
  },

  /**
   * Get all folders containing notes.
   */
  getFolders: (): Promise<string[]> => {
    return window.api.notes.getFolders()
  },

  /**
   * Create a new folder.
   */
  createFolder: (path: string): Promise<{ success: boolean }> => {
    return window.api.notes.createFolder(path)
  },

  /**
   * Rename a folder.
   */
  renameFolder: (oldPath: string, newPath: string): Promise<{ success: boolean }> => {
    return window.api.notes.renameFolder(oldPath, newPath)
  },

  /**
   * Delete a folder and all its contents.
   */
  deleteFolder: (path: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.notes.deleteFolder(path)
  },

  /**
   * Check if a note exists by title or path.
   */
  exists: (titleOrPath: string): Promise<boolean> => {
    return window.api.notes.exists(titleOrPath)
  },

  /**
   * Open note in default external editor.
   */
  openExternal: (id: string): Promise<void> => {
    return window.api.notes.openExternal(id)
  },

  /**
   * Reveal note file in Finder/Explorer.
   */
  revealInFinder: (id: string): Promise<void> => {
    return window.api.notes.revealInFinder(id)
  },

  // =========================================================================
  // T021: Properties API
  // =========================================================================

  /**
   * Get properties for a note.
   */
  getProperties: (noteId: string): Promise<PropertyValue[]> => {
    return window.api.notes.getProperties(noteId)
  },

  /**
   * Set properties for a note.
   */
  setProperties: async (
    noteId: string,
    properties: Record<string, unknown>
  ): Promise<SetPropertiesResponse> => {
    const result = await window.api.notes.setProperties(noteId, properties)
    return result
  },

  /**
   * Get all property definitions.
   */
  getPropertyDefinitions: (): Promise<PropertyDefinition[]> => {
    return window.api.notes.getPropertyDefinitions()
  },

  /**
   * Create a new property definition.
   */
  createPropertyDefinition: (
    input: CreatePropertyDefinitionInput
  ): Promise<CreatePropertyDefinitionResponse> => {
    return window.api.notes.createPropertyDefinition(input)
  },

  /**
   * Update an existing property definition.
   */
  updatePropertyDefinition: (
    input: UpdatePropertyDefinitionInput
  ): Promise<CreatePropertyDefinitionResponse> => {
    return window.api.notes.updatePropertyDefinition(input)
  },

  // =========================================================================
  // T070: Attachments API
  // =========================================================================

  /**
   * Upload an attachment to a note.
   * @param noteId - The note ID to attach to
   * @param file - The file to upload
   * @returns AttachmentResult with path and metadata
   */
  uploadAttachment: (noteId: string, file: File): Promise<AttachmentResult> => {
    return window.api.notes.uploadAttachment(noteId, file)
  },

  /**
   * List all attachments for a note.
   * @param noteId - The note ID
   * @returns Array of attachment info
   */
  listAttachments: (noteId: string): Promise<AttachmentInfo[]> => {
    return window.api.notes.listAttachments(noteId)
  },

  /**
   * Delete an attachment from a note.
   * @param noteId - The note ID
   * @param filename - The filename to delete
   */
  deleteAttachment: (noteId: string, filename: string): Promise<DeleteAttachmentResponse> => {
    return window.api.notes.deleteAttachment(noteId, filename)
  },

  // =========================================================================
  // T096.5: Folder Config API
  // =========================================================================

  /**
   * Get folder configuration (default template, inheritance settings).
   * @param folderPath - The folder path
   */
  getFolderConfig: (folderPath: string): Promise<FolderConfig | null> => {
    return window.api.notes.getFolderConfig(folderPath)
  },

  /**
   * Set folder configuration.
   * @param folderPath - The folder path
   * @param config - The folder config to set
   */
  setFolderConfig: (
    folderPath: string,
    config: FolderConfig
  ): Promise<{ success: boolean; error?: string }> => {
    return window.api.notes.setFolderConfig(folderPath, config)
  },

  /**
   * Get effective template for a folder (considering inheritance).
   * @param folderPath - The folder path
   */
  getFolderTemplate: (folderPath: string): Promise<string | null> => {
    return window.api.notes.getFolderTemplate(folderPath)
  },

  // =========================================================================
  // T106, T108: Export API
  // =========================================================================

  /**
   * Export a note as PDF.
   * Opens a save dialog and exports the note to the selected location.
   * @param input - Export options including noteId, includeMetadata, and pageSize
   */
  exportPdf: (input: ExportNoteInput): Promise<ExportNoteResponse> => {
    return window.api.notes.exportPdf(input)
  },

  /**
   * Export a note as HTML.
   * Opens a save dialog and exports the note to the selected location.
   * @param input - Export options including noteId and includeMetadata
   */
  exportHtml: (input: ExportNoteInput): Promise<ExportNoteResponse> => {
    return window.api.notes.exportHtml(input)
  },

  // =========================================================================
  // T114: Version History API
  // =========================================================================

  /**
   * Get version history for a note.
   * Returns list of snapshots ordered by creation date descending.
   * @param noteId - The note ID
   */
  getVersions: (noteId: string): Promise<SnapshotListItem[]> => {
    return window.api.notes.getVersions(noteId)
  },

  /**
   * Get a specific version/snapshot with full content.
   * @param snapshotId - The snapshot ID
   */
  getVersion: (snapshotId: string): Promise<SnapshotDetail | null> => {
    return window.api.notes.getVersion(snapshotId)
  },

  /**
   * Restore a note from a previous version.
   * Creates a snapshot of current state before restoring.
   * @param snapshotId - The snapshot ID to restore from
   */
  restoreVersion: (snapshotId: string): Promise<RestoreVersionResponse> => {
    return window.api.notes.restoreVersion(snapshotId)
  },

  /**
   * Delete a specific version/snapshot.
   * @param snapshotId - The snapshot ID to delete
   */
  deleteVersion: (snapshotId: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.notes.deleteVersion(snapshotId)
  },

  getPositions: (folderPath: string): Promise<Map<string, number>> => {
    return window.api.notes.getPositions(folderPath)
  },

  getAllPositions: (): Promise<{
    success: boolean
    positions: Record<string, number>
    error?: string
  }> => {
    return window.api.notes.getAllPositions()
  },

  reorder: (
    folderPath: string,
    notePaths: string[]
  ): Promise<{ success: boolean; error?: string }> => {
    return window.api.notes.reorder(folderPath, notePaths)
  },

  /**
   * Import files from external paths into the vault.
   */
  importFiles: (sourcePaths: string[], targetFolder?: string) => {
    return window.api.notes.importFiles(sourcePaths, targetFolder)
  },

  /**
   * Show a file dialog to select files for import.
   */
  showImportDialog: () => {
    return window.api.notes.showImportDialog()
  }
}

// ============================================================================
// Event Subscriptions
// ============================================================================

/**
 * Subscribe to note created events.
 * Returns unsubscribe function.
 */
export function onNoteCreated(callback: (event: NoteCreatedEvent) => void): () => void {
  return window.api.onNoteCreated(callback)
}

/**
 * Subscribe to note updated events.
 * Returns unsubscribe function.
 */
export function onNoteUpdated(callback: (event: NoteUpdatedEvent) => void): () => void {
  return window.api.onNoteUpdated(callback)
}

/**
 * Subscribe to note deleted events.
 * Returns unsubscribe function.
 */
export function onNoteDeleted(callback: (event: NoteDeletedEvent) => void): () => void {
  return window.api.onNoteDeleted(callback)
}

/**
 * Subscribe to note renamed events.
 * Returns unsubscribe function.
 */
export function onNoteRenamed(callback: (event: NoteRenamedEvent) => void): () => void {
  return window.api.onNoteRenamed(callback)
}

/**
 * Subscribe to note moved events.
 * Returns unsubscribe function.
 */
export function onNoteMoved(callback: (event: NoteMovedEvent) => void): () => void {
  return window.api.onNoteMoved(callback)
}

/**
 * Subscribe to external file change events.
 * Fired when note files are modified outside the app.
 * Returns unsubscribe function.
 */
export function onNoteExternalChange(
  callback: (event: NoteExternalChangeEvent) => void
): () => void {
  return window.api.onNoteExternalChange(callback)
}

// Re-export types for convenience
export type {
  Note,
  NoteListItem,
  NoteCreateResponse,
  NoteUpdateResponse,
  NoteListResponse,
  NoteLinksResponse,
  NoteCreatedEvent,
  NoteUpdatedEvent,
  NoteDeletedEvent,
  NoteRenamedEvent,
  NoteMovedEvent,
  NoteExternalChangeEvent,
  PropertyValue,
  PropertyDefinition,
  SetPropertiesResponse,
  CreatePropertyDefinitionInput,
  CreatePropertyDefinitionResponse,
  UpdatePropertyDefinitionInput,
  AttachmentResult,
  AttachmentInfo,
  DeleteAttachmentResponse,
  ExportNoteInput,
  ExportNoteResponse,
  // Version history types (T114)
  SnapshotListItem,
  SnapshotDetail,
  RestoreVersionResponse
}
