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
import type { NoteLinksChangedEvent, UnlinkedMention } from '@memry/contracts/notes-api'
import { markdownPreviewText } from '@memry/shared/markdown-preview-text'
import { getI18n } from 'react-i18next'
import {
  commands,
  events,
  type DefinitionInput,
  type FileView,
  type NoteListItemView,
  type NoteView,
  type PropertyDefinitionView,
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

/** `stringifyDefaultValue` of Electron's `ipc/notes-handlers.ts`; none keeps the stored one. */
function defaultValueText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'symbol') return value.description ?? value.toString()
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value) ?? ''
}

/**
 * A definition as Electron's list gives it. `@memry/rpc` types `type` without `project`, which
 * that list returns as well.
 */
function toDefinition(view: PropertyDefinitionView): PropertyDefinition {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same fields; only the `type` union is wider than the rpc one, as Electron's own rows are
  return view as PropertyDefinition
}

function definitionInput(
  input: CreatePropertyDefinitionInput | UpdatePropertyDefinitionInput
): DefinitionInput {
  return { ...input, defaultValue: defaultValueText(input.defaultValue) }
}

/**
 * The notes commands of Step 13f, the link reads of Step 13i and the property definitions of
 * Step 13k (`commands/notes.rs`, `commands/property_definitions.rs`); every other method still
 * goes to `window.api.notes`.
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
  },
  getLinks: (id: string): Promise<NoteLinksResponse> => commands.notesGetLinks(id),
  resolveByTitle: (title: string): Promise<WikiLinkResolution | null> =>
    commands.notesResolveByTitle(title),
  resolveTitles: (titles: string[]): Promise<WikiLinkTitleResolutions> =>
    commands.notesResolveTitles(titles),
  resolveWikiTarget: (target: string): Promise<WikiLinkTargetResolution | null> =>
    commands.notesResolveWikiTarget(target),
  getUnlinkedMentions: (id: string): Promise<UnlinkedMention[]> =>
    commands.notesGetUnlinkedMentions(id),
  // The card's opening is read here from the body Rust sends, with the function Electron's main
  // ran on it; a card with a description gets no body.
  previewByTitle: async (title: string): Promise<WikiLinkPreview | null> => {
    const preview = await commands.notesPreviewByTitle(title)
    if (!preview) return null
    const { body, ...rest } = preview
    return { ...rest, bodyText: body === null ? null : markdownPreviewText(body) }
  },
  // Rejects on failure rather than answering `success: false`: the note page reads no envelope
  // and would announce a change that did not happen (a note too large to sync stays local-only).
  setLocalOnly: async (id: string, localOnly: boolean) => {
    const note = await commands.notesSetLocalOnly(id, localOnly)
    return { success: true, note: toNote(note) }
  },
  getLocalOnlyCount: async (): Promise<{ count: number }> => ({
    count: await commands.notesGetLocalOnlyCount()
  }),
  getPropertyDefinitions: async (): Promise<PropertyDefinition[]> =>
    (await commands.notesGetPropertyDefinitions()).map(toDefinition),
  // A create or an update answers its failure as Electron's `registerCommand` does; the option
  // edits reject.
  createPropertyDefinition: async (
    input: CreatePropertyDefinitionInput
  ): Promise<CreatePropertyDefinitionResponse> => {
    try {
      const definition = await commands.notesCreatePropertyDefinition(definitionInput(input))
      return { success: true, definition: definition && toDefinition(definition) }
    } catch (error) {
      return { ...failure(error), definition: null }
    }
  },
  updatePropertyDefinition: async (
    input: UpdatePropertyDefinitionInput
  ): Promise<CreatePropertyDefinitionResponse> => {
    try {
      const definition = await commands.notesUpdatePropertyDefinition(definitionInput(input))
      if (definition) return { success: true, definition: toDefinition(definition) }
      const error = getI18n().t('system:error.definitionNotFound')
      return { success: false, definition: null, error }
    } catch (error) {
      return { ...failure(error), definition: null }
    }
  },
  ensurePropertyDefinition: async (name, type) => {
    await commands.notesEnsurePropertyDefinition(name, type)
    return { success: true }
  },
  addPropertyOption: async (propertyName, option) => {
    await commands.notesAddPropertyOption(propertyName, option)
    return { success: true }
  },
  addStatusOption: async (propertyName, categoryKey, option) => {
    await commands.notesAddStatusOption(propertyName, categoryKey, option)
    return { success: true }
  },
  removePropertyOption: async (propertyName, optionValue) => {
    await commands.notesRemovePropertyOption(propertyName, optionValue)
    return { success: true }
  },
  renamePropertyOption: async (propertyName, oldValue, newValue) => {
    await commands.notesRenamePropertyOption(propertyName, oldValue, newValue)
    return { success: true }
  },
  updateOptionColor: async (propertyName, optionValue, newColor) => {
    await commands.notesUpdateOptionColor(propertyName, optionValue, newColor)
    return { success: true }
  },
  deletePropertyDefinition: async (name) => {
    await commands.notesDeletePropertyDefinition(name)
    return { success: true }
  },
  setCalendarPropertyVisibility: async (name, showOnCalendar) => {
    await commands.notesSetCalendarPropertyVisibility(name, showOnCalendar)
    return { success: true }
  },
  getCalendarPropertyNames: (): Promise<string[]> => commands.notesGetCalendarPropertyNames()
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

/**
 * The note index committed links that changed: the notes whose links changed (`sourceIds`) and
 * every note that gained or lost a link to it (`targetIds`). It comes after the rows are written,
 * where a note event comes before, so a links read on it sees the edit.
 */
export function onNoteLinksChanged(callback: (event: NoteLinksChangedEvent) => void): () => void {
  return subscribeToEvent(events.noteLinksChangedEvent, callback)
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
