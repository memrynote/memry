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
  WikiLinkResolution,
  WikiLinkTargetResolution,
  WikiLinkTitleResolutions
} from '@memry/rpc/notes'
import type { NoteLinksChangedEvent } from '@memry/contracts/notes-api'
import {
  commands,
  type FileView,
  type NoteListItemView,
  type NoteView
} from '../../../generated/bindings'
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

function toNote(view: NoteView): Note {
  return { ...view, created: new Date(view.created), modified: new Date(view.modified) }
}

function toListItem(view: NoteListItemView): NoteListItem {
  return { ...view, created: new Date(view.created), modified: new Date(view.modified) }
}

function toFile(view: FileView): FileMetadata {
  return { ...view, created: new Date(view.created), modified: new Date(view.modified) }
}

/**
 * The note reads of Step 13f (`commands/notes.rs`) and the link reads of Step 13i
 * (`commands/note_links.rs`). Every other method, the create and the delete included, still
 * goes to `window.api.notes`.
 */
const ported = {
  get: async (id: string): Promise<Note | null> => {
    const note = await commands.notesGet(id)
    return note ? toNote(note) : null
  },
  getByPath: async (path: string): Promise<Note | null> => {
    const note = await commands.notesGetByPath(path)
    return note ? toNote(note) : null
  },
  getFile: async (id: string): Promise<FileMetadata | null> => {
    const file = await commands.notesGetFile(id)
    return file ? toFile(file) : null
  },
  list: async (options?: NoteListOptions): Promise<NoteListResponse> => {
    const page = await commands.notesList(options ?? {})
    return { ...page, notes: page.notes.map(toListItem) }
  },
  exists: (titleOrPath: string): Promise<boolean> => commands.notesExists(titleOrPath),
  openExternal: async (id: string): Promise<void> => {
    await commands.notesOpenExternal(id)
  },
  revealInFinder: async (id: string): Promise<void> => {
    await commands.notesRevealInFinder(id)
  },
  getLinks: (id: string): Promise<NoteLinksResponse> => commands.notesGetLinks(id),
  resolveByTitle: (title: string): Promise<WikiLinkResolution | null> =>
    commands.notesResolveByTitle(title),
  resolveTitles: (titles: string[]): Promise<WikiLinkTitleResolutions> =>
    commands.notesResolveTitles(titles),
  resolveWikiTarget: (target: string): Promise<WikiLinkTargetResolution | null> =>
    commands.notesResolveWikiTarget(target)
} satisfies Partial<NotesClientAPI>

/** The note methods served from Rust; `window.api.notes` is typed without them. */
export type PortedNoteMethod = keyof typeof ported

export const notesService: NotesClientAPI = createWindowApiForwarder<
  NotesClientAPI,
  PortedNoteMethod
>(() => window.api.notes, ported)

export function onNoteCreated(callback: (event: NoteCreatedEvent) => void): () => void {
  return window.api.onNoteCreated(callback)
}

export function onNoteUpdated(callback: (event: NoteUpdatedEvent) => void): () => void {
  // `changes` is required by the contract but the wire is untyped, and a main
  // process from an older install can still send a payload without it. Every
  // subscriber dereferences `changes`, so normalize once here rather than
  // guarding at each call site — a throwing listener silently drops the event.
  return window.api.onNoteUpdated((event) => {
    callback(event.changes ? event : { ...event, changes: {} })
  })
}

export function onNoteDeleted(callback: (event: NoteDeletedEvent) => void): () => void {
  return window.api.onNoteDeleted(callback)
}

export function onNoteRenamed(callback: (event: NoteRenamedEvent) => void): () => void {
  return window.api.onNoteRenamed(callback)
}

export function onNoteLinksChanged(callback: (event: NoteLinksChangedEvent) => void): () => void {
  return window.api.onLinksChanged(callback)
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
