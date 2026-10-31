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
import type { NoteLinksChangedEvent } from '@memry/contracts/notes-api'
import {
  commands,
  events,
  type FileView,
  type NoteListItemView,
  type NoteView,
  type Value
} from '../../../generated/bindings'
import { extractErrorMessage } from '../lib/ipc-error'
import { NotPortedError } from '../lib/not-ported'
import { subscribeToEvent } from './tauri-event'
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

/** A failed create or delete as Electron's `withErrorHandler` answers it: the error's message. */
function failure(error: unknown): { success: false; error?: string } {
  const message = extractErrorMessage(error, '')
  return message ? { success: false, error: message } : { success: false }
}

/**
 * The notes commands of Step 13f (`commands/notes.rs`); every other method still goes to
 * `window.api.notes`.
 */
const ported = {
  create: async (input: NoteCreateInput): Promise<NoteCreateResponse> => {
    // Their steps (13l, 32) port them; a create without them would lose what was asked.
    if (input.template !== undefined) throw new NotPortedError('notes.create({ template })')
    if (input.plainChecklists) throw new NotPortedError('notes.create({ plainChecklists })')
    try {
      const note = await commands.notesCreate({
        title: input.title,
        content: input.content,
        folder: input.folder,
        tags: input.tags,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- property values are the JSON the command carries as is
        properties: input.properties as Record<string, Value> | undefined,
        emoji: input.emoji
      })
      return { success: true, note: toNote(note) }
    } catch (error) {
      return { ...failure(error), note: null }
    }
  },
  delete: async (id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await commands.notesDelete(id)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
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
  }
} satisfies Partial<NotesClientAPI>

/** The note methods served from Rust; `window.api.notes` is typed without them. */
export type PortedNoteMethod = keyof typeof ported

export const notesService: NotesClientAPI = createWindowApiForwarder<
  NotesClientAPI,
  PortedNoteMethod
>(() => window.api.notes, ported)

/** The subscriptions below that Rust events serve; `window.api` is typed without them. */
export type PortedNoteEvent = 'onNoteCreated' | 'onNoteUpdated' | 'onNoteDeleted'

/** A note made by the app or from a file that appeared (`shell/note_events.rs`). */
export function onNoteCreated(callback: (event: NoteCreatedEvent) => void): () => void {
  return subscribeToEvent(events.noteCreatedEvent, ({ note, source }) =>
    callback({ note: toListItem(note), source })
  )
}

/**
 * A note changed; `changes` holds the `Note` fields that may have, as the note reads now. Its
 * `modified` arrives as epoch milliseconds and is handed on as a `Date`, as every `Note` date is.
 */
export function onNoteUpdated(callback: (event: NoteUpdatedEvent) => void): () => void {
  return subscribeToEvent(events.noteUpdatedEvent, ({ id, changes, source }) => {
    const { modified, ...rest } = changes
    callback({
      id,
      changes: typeof modified === 'number' ? { ...rest, modified: new Date(modified) } : rest,
      source
    })
  })
}

export function onNoteDeleted(callback: (event: NoteDeletedEvent) => void): () => void {
  return subscribeToEvent(events.noteDeletedEvent, callback)
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
