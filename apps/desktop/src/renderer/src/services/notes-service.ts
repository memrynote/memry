import type {
  AttachmentInfo,
  AttachmentResult,
  CreatePropertyDefinitionInput,
  CreatePropertyDefinitionResponse,
  DeleteAttachmentResponse,
  ExportNoteInput,
  ExportNoteResponse,
  FileMetadata,
  FolderConfig,
  FolderInfo,
  ImportDialogResponse,
  ImportFilesResponse,
  Note,
  NoteCreatedEvent,
  NoteCreateInput,
  NoteCreateResponse,
  NoteDeletedEvent,
  NoteExternalChangeEvent,
  NoteLinksResponse,
  NoteListItem,
  NoteListOptions,
  NoteListResponse,
  NoteMovedEvent,
  NotePositionsResponse,
  NoteRenamedEvent,
  NotesClientAPI,
  NoteUpdateInput,
  NoteUpdateResponse,
  NoteUpdatedEvent,
  PropertyDefinition,
  RestoreVersionResponse,
  SnapshotDetail,
  SnapshotListItem,
  UpdatePropertyDefinitionInput,
  WikiLinkPreview,
  WikiLinkResolution
} from '@memry/rpc/notes'

export type {
  AttachmentInfo,
  AttachmentResult,
  CreatePropertyDefinitionInput,
  CreatePropertyDefinitionResponse,
  DeleteAttachmentResponse,
  ExportNoteInput,
  ExportNoteResponse,
  FileMetadata,
  FolderConfig,
  FolderInfo,
  ImportDialogResponse,
  ImportFilesResponse,
  Note,
  NoteCreatedEvent,
  NoteCreateInput,
  NoteCreateResponse,
  NoteDeletedEvent,
  NoteExternalChangeEvent,
  NoteLinksResponse,
  NoteListItem,
  NoteListOptions,
  NoteListResponse,
  NoteMovedEvent,
  NotePositionsResponse,
  NoteRenamedEvent,
  NotesClientAPI,
  NoteUpdateInput,
  NoteUpdateResponse,
  NoteUpdatedEvent,
  PropertyDefinition,
  RestoreVersionResponse,
  SnapshotDetail,
  SnapshotListItem,
  UpdatePropertyDefinitionInput,
  WikiLinkPreview,
  WikiLinkResolution
}

export const notesService: NotesClientAPI = {
  create: (input) => window.api.notes.create(input),
  get: (id) => window.api.notes.get(id),
  getByPath: (path) => window.api.notes.getByPath(path),
  getFile: (id) => window.api.notes.getFile(id),
  resolveByTitle: (title) => window.api.notes.resolveByTitle(title),
  previewByTitle: (title) => window.api.notes.previewByTitle(title),
  update: (input) => window.api.notes.update(input),
  rename: (id, newTitle) => window.api.notes.rename(id, newTitle),
  move: (id, newFolder) => window.api.notes.move(id, newFolder),
  delete: (id) => window.api.notes.delete(id),
  list: (options) => window.api.notes.list(options),
  getTags: () => window.api.notes.getTags(),
  getLinks: (id) => window.api.notes.getLinks(id),
  getFolders: () => window.api.notes.getFolders(),
  createFolder: (path) => window.api.notes.createFolder(path),
  renameFolder: (oldPath, newPath) => window.api.notes.renameFolder(oldPath, newPath),
  deleteFolder: (path) => window.api.notes.deleteFolder(path),
  exists: (titleOrPath) => window.api.notes.exists(titleOrPath),
  openExternal: (id) => window.api.notes.openExternal(id),
  revealInFinder: (id) => window.api.notes.revealInFinder(id),
  getPropertyDefinitions: () => window.api.notes.getPropertyDefinitions(),
  createPropertyDefinition: (input) => window.api.notes.createPropertyDefinition(input),
  updatePropertyDefinition: (input) => window.api.notes.updatePropertyDefinition(input),
  ensurePropertyDefinition: (name, type) => window.api.notes.ensurePropertyDefinition(name, type),
  addPropertyOption: (propertyName, option) => window.api.notes.addPropertyOption(propertyName, option),
  addStatusOption: (propertyName, categoryKey, option) =>
    window.api.notes.addStatusOption(propertyName, categoryKey, option),
  removePropertyOption: (propertyName, optionValue) =>
    window.api.notes.removePropertyOption(propertyName, optionValue),
  renamePropertyOption: (propertyName, oldValue, newValue) =>
    window.api.notes.renamePropertyOption(propertyName, oldValue, newValue),
  updateOptionColor: (propertyName, optionValue, newColor) =>
    window.api.notes.updateOptionColor(propertyName, optionValue, newColor),
  deletePropertyDefinition: (name) => window.api.notes.deletePropertyDefinition(name),
  uploadAttachment: (noteId, file) => window.api.notes.uploadAttachment(noteId, file),
  listAttachments: (noteId) => window.api.notes.listAttachments(noteId),
  deleteAttachment: (noteId, filename) => window.api.notes.deleteAttachment(noteId, filename),
  getFolderConfig: (folderPath) => window.api.notes.getFolderConfig(folderPath),
  setFolderConfig: (folderPath, config) => window.api.notes.setFolderConfig(folderPath, config),
  getFolderTemplate: (folderPath) => window.api.notes.getFolderTemplate(folderPath),
  exportPdf: (input) => window.api.notes.exportPdf(input),
  exportHtml: (input) => window.api.notes.exportHtml(input),
  getVersions: (noteId) => window.api.notes.getVersions(noteId),
  getVersion: (snapshotId) => window.api.notes.getVersion(snapshotId),
  restoreVersion: (snapshotId) => window.api.notes.restoreVersion(snapshotId),
  deleteVersion: (snapshotId) => window.api.notes.deleteVersion(snapshotId),
  getPositions: (folderPath) => window.api.notes.getPositions(folderPath),
  getAllPositions: () => window.api.notes.getAllPositions(),
  reorder: (folderPath, notePaths) => window.api.notes.reorder(folderPath, notePaths),
  importFiles: (sourcePaths, targetFolder) => window.api.notes.importFiles(sourcePaths, targetFolder),
  showImportDialog: () => window.api.notes.showImportDialog(),
  setLocalOnly: (id, localOnly) => window.api.notes.setLocalOnly(id, localOnly),
  getLocalOnlyCount: () => window.api.notes.getLocalOnlyCount()
}

export function onNoteCreated(callback: (event: NoteCreatedEvent) => void): () => void {
  return window.api.onNoteCreated(callback)
}

export function onNoteUpdated(callback: (event: NoteUpdatedEvent) => void): () => void {
  return window.api.onNoteUpdated(callback)
}

export function onNoteDeleted(callback: (event: NoteDeletedEvent) => void): () => void {
  return window.api.onNoteDeleted(callback)
}

export function onNoteRenamed(callback: (event: NoteRenamedEvent) => void): () => void {
  return window.api.onNoteRenamed(callback)
}

export function onNoteMoved(callback: (event: NoteMovedEvent) => void): () => void {
  return window.api.onNoteMoved(callback)
}

export function onNoteExternalChange(
  callback: (event: NoteExternalChangeEvent) => void
): () => void {
  return window.api.onNoteExternalChange(callback)
}

export function onTagsChanged(callback: () => void): () => void {
  return window.api.onTagsChanged(callback)
}
