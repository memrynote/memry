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
import { NOTE_METHODS_WITH_DATES, reviveNoteDates } from './notes-response-adapter'

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

// Tauri ships note timestamps as ISO strings, but the renderer (and the
// `Note` / `NoteListItem` types) expect `Date` objects. Wrap the forwarder
// so methods that return note DTOs get a Date-revival pass at the IPC
// boundary, keeping consumers like `notes-tree-utils` (`modified.getTime()`)
// working without per-call-site changes. Methods that don't ship Dates
// (positions, exists, tags, etc.) bypass the wrapper.
const rawNotesService = createInvokeForwarder<NotesClientAPI>('notes')

export const notesService: NotesClientAPI = new Proxy(rawNotesService, {
  get(target, property, receiver) {
    if (typeof property !== 'string' || !NOTE_METHODS_WITH_DATES.has(property)) {
      return Reflect.get(target, property, receiver)
    }
    const original = Reflect.get(target, property, receiver) as (
      ...args: unknown[]
    ) => Promise<unknown>
    return async (...args: unknown[]) => reviveNoteDates(await original(...args))
  }
}) as NotesClientAPI

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
