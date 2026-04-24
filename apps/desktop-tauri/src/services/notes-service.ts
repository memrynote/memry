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
import { createInvokeForwarder, subscribeEvent } from '@/lib/ipc/forwarder'

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

export const notesService: NotesClientAPI = createInvokeForwarder<NotesClientAPI>('notes')

export function onNoteCreated(callback: (event: NoteCreatedEvent) => void): () => void {
  return subscribeEvent<NoteCreatedEvent>('note-created', callback)
}

export function onNoteUpdated(callback: (event: NoteUpdatedEvent) => void): () => void {
  return subscribeEvent<NoteUpdatedEvent>('note-updated', callback)
}

export function onNoteDeleted(callback: (event: NoteDeletedEvent) => void): () => void {
  return subscribeEvent<NoteDeletedEvent>('note-deleted', callback)
}

export function onNoteRenamed(callback: (event: NoteRenamedEvent) => void): () => void {
  return subscribeEvent<NoteRenamedEvent>('note-renamed', callback)
}

export function onNoteMoved(callback: (event: NoteMovedEvent) => void): () => void {
  return subscribeEvent<NoteMovedEvent>('note-moved', callback)
}

export function onNoteExternalChange(
  callback: (event: NoteExternalChangeEvent) => void
): () => void {
  return subscribeEvent<NoteExternalChangeEvent>('note-external-change', callback)
}

export function onTagsChanged(callback: () => void): () => void {
  return subscribeEvent<void>('tags-changed', callback)
}

export function onFolderConfigUpdated(callback: (event: { path: string }) => void): () => void {
  return subscribeEvent<{ path: string }>('folder-config-updated', callback)
}
