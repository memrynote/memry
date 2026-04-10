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
import { createWindowApiForwarder } from './window-api-forwarder'

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

export const notesService: NotesClientAPI = createWindowApiForwarder(() => window.api.notes)

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

export function onFolderConfigUpdated(callback: (event: { path: string }) => void): () => void {
  return window.api.onFolderConfigUpdated(callback)
}
