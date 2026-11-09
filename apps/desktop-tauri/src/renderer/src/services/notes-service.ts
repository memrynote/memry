import type {
  ApplyTemplateInput,
  AttachmentInfo,
  AttachmentResult,
  AttachmentUploadFile,
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
import type {
  NoteAliasEdit,
  NoteAliasEditResponse,
  NoteLinkMention,
  NoteLinkMentionResponse,
  NoteLinksChangedEvent,
  UndoTagTemplateResponse,
  UnlinkedMention
} from '@memry/contracts/notes-api'
import { markdownPreviewText } from '@memry/shared/markdown-preview-text'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import {
  commands,
  events,
  type DefinitionInput,
  type FileView,
  type FolderConfigUpdatedEvent,
  type NoteListItemView,
  type NoteView,
  type PropertyDefinitionView,
  type RefsKept,
  type UndoTagTemplateInput,
  type Value,
  type VersionView
} from '../../../generated/bindings'
import { invokeBinary } from '../lib/ipc-binary'
import { askPermanentDelete } from '../lib/permanent-delete-question'
import { commandErrorCode, extractErrorMessage } from '../lib/ipc-error'
import { createLogger } from '../lib/logger'
import { NotPortedError } from '../lib/not-ported'
import { subscribeToEvent } from './tauri-event'
import { createWindowApiForwarder } from './window-api-forwarder'

const log = createLogger('Service:Notes')

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

/** A version as the history lists it. Rust sends the stored reason, which only Memry writes. */
function toVersion(view: VersionView): SnapshotListItem {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- string DB/wire column narrowed to the union its writers constrain
  return { ...view, reason: view.reason as SnapshotListItem['reason'] }
}

function toFile(view: FileView): FileMetadata {
  return { ...view, created: new Date(view.created), modified: new Date(view.modified) }
}

// A bulk move (the folder view, a multi-select drag) answers note by note. The notes whose
// refs stayed share one warning, which counts them until it closes. One whose file Memry
// cannot edit keeps the warning's "by hand".
const REFS_KEPT_TOAST = 'notes-moved-refs-kept'
const refsKeptNotes = new Map<string, RefsKept>()

function refsKeptMessage(note: NoteView, refsKept: RefsKept): string {
  const t = getI18n().getFixedT(null, 'notes')
  const count = refsKeptNotes.size
  const unreadable = [...refsKeptNotes.values()].includes('unreadable')
  if (count > 1 && unreadable) return t('movedRefsKept.severalUnreadable', { count })
  if (count > 1) return t('movedRefsKept.several', { count })
  return refsKept === 'changing'
    ? t('movedRefsKept.changing', { title: note.title })
    : t('movedRefsKept.unreadable', { title: note.title })
}

function warnRefsKept(note: NoteView, refsKept: RefsKept): void {
  refsKeptNotes.set(note.id, refsKept)
  const message = refsKeptMessage(note, refsKept)
  const closed = (): void => refsKeptNotes.clear()
  toast.warning(message, { id: REFS_KEPT_TOAST, onDismiss: closed, onAutoClose: closed })
}

/** A failed create or delete as Electron's `withErrorHandler` answers it: the error's message. */
function failure(error: unknown): { success: false; error?: string } {
  const message = extractErrorMessage(error, '')
  return message ? { success: false, error: message } : { success: false }
}

/**
 * The largest file one upload body carries (`memry_desktop::attachments::MAX_UPLOAD_BODY`). A
 * larger one goes in parts of `UPLOAD_CHUNK_BYTES` (`attachments::CHUNK_BYTES`), up to the
 * 100 MiB attachment cap.
 */
const MAX_UPLOAD_BODY = 16 * 1024 * 1024
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/** What `notes_upload_attachment` answers (`memry_desktop::attachments::SavedAttachment`). */
type SavedAttachment = Required<
  Pick<AttachmentResult, 'path' | 'name' | 'size' | 'mimeType' | 'type'>
>

/** A file the upload can read part by part: a DOM `File`. */
type SlicedFile = { name: string; size: number; slice: (start: number, end: number) => Blob }

/**
 * Sends `file` one part at a time, so only one part is in memory. Rust refuses the size, type or
 * note before a byte is read, keeps the parts out of the attachments folder, and moves the file
 * in after the last one, which answers it. A failure cancels the upload, so nothing is left.
 */
async function uploadInParts(noteId: string, file: SlicedFile): Promise<SavedAttachment> {
  const id = await commands.notesUploadAttachmentBegin(noteId, file.name, file.size)
  try {
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
      const part = file.slice(offset, offset + UPLOAD_CHUNK_BYTES)
      const bytes = new Uint8Array(await part.arrayBuffer())
      const meta = { id, offset }
      const saved = await invokeBinary<SavedAttachment | null>(
        'notes_upload_attachment_chunk',
        bytes,
        meta
      )
      if (saved) return saved
    }
    // The file shrank after it was picked: Rust still waits for bytes, so the upload failed.
    throw new Error(getI18n().getFixedT(null, 'errors')('attachment.writeFailed'))
  } catch (error) {
    // The page that began it ends it too when it reloads or closes; this is the failed send.
    await commands.notesUploadAttachmentAbort(id).catch((abortError: unknown) => {
      log.warn('an upload was not cancelled', abortError)
    })
    throw error
  }
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
 * The notes commands of Step 13f (the edit of 13f-3c included), the rename, move and manual
 * order of Step 13g, the link reads and the mention link of Step 13i, the property definitions of
 * Step 13k, the folder reads, create and settings of Step 13h, a template applied to a note
 * (13l), a note's other names and the tag list of 13q, and the attachment upload of 14f-1
 * (`commands/notes.rs`, `commands/property_definitions.rs`, `commands/folders.rs`,
 * `commands/tags.rs`, `commands/attachments.rs`), and the version history of 14d
 * (`commands/notes_versions.rs`); every other method still goes to `window.api.notes`.
 */
const ported = {
  create: async (input: NoteCreateInput): Promise<NoteCreateResponse> => {
    // Step 32 ports it; a create without it would lose what was asked.
    if (input.plainChecklists) throw new NotPortedError('notes.create({ plainChecklists })')
    try {
      const note = await commands.notesCreate({
        title: input.title,
        content: input.content,
        folder: input.folder,
        tags: input.tags,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- property values are the JSON the command carries as is
        properties: input.properties as Record<string, Value> | undefined,
        template: input.template,
        // Left out, the template's icon; `null`, none.
        emoji: input.emoji
      })
      return { success: true, note: toNote(note) }
    } catch (error) {
      return { ...failure(error), note: null }
    }
  },
  delete: async (id: string): Promise<{ success: boolean; error?: string }> => {
    let refusal: unknown
    try {
      await commands.notesDelete(id, null)
      return { success: true }
    } catch (error) {
      if (commandErrorCode(error) !== 'note_trash_unavailable') return failure(error)
      refusal = error
    }
    // The trash refused a file with text the note never read (#3813): the user decides, told
    // which note. A note that cannot be read is not asked about.
    const note = await commands.notesGet(id).catch(() => null)
    if (!note) return failure(refusal)
    if (!(await askPermanentDelete(id, note.title))) {
      return { success: false, error: getI18n().t('notes:trashUnavailable.kept') }
    }
    try {
      await commands.notesDelete(id, true)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  // `title` is `notes:rename`'s: Electron's update renames the record and leaves the file, and no
  // caller sends one, so it stays refused. A failure answers as Electron's `registerCommand` does.
  update: async (input: NoteUpdateInput): Promise<NoteUpdateResponse> => {
    if (input.title !== undefined) throw new NotPortedError('notes.update({ title })')
    try {
      const { id, content, headerTags, emoji, frontmatter } = input
      const { note, tagTemplate, keptOutsideEdit, savedContent } = await commands.notesUpdate({
        id,
        content,
        headerTags,
        emoji,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- frontmatter values are the JSON the command carries as is
        frontmatter: frontmatter as Record<string, Value> | undefined
      })
      return {
        success: true,
        note: toNote(note),
        ...(tagTemplate && { tagTemplate }),
        ...(keptOutsideEdit && { keptOutsideEdit }),
        ...(savedContent !== undefined && { savedContent })
      }
    } catch (error) {
      return { ...failure(error), note: null }
    }
  },
  // `plainChecklists` is Step 32's; an apply without it would drop what was asked. A failure
  // answers as Electron's `registerCommand` does.
  applyTemplate: async (input: ApplyTemplateInput): Promise<NoteUpdateResponse> => {
    if (input.plainChecklists) throw new NotPortedError('notes.applyTemplate({ plainChecklists })')
    try {
      const { noteId, templateId, mode } = input
      const note = await commands.notesApplyTemplate({ noteId, templateId, mode })
      return { success: true, note: toNote(note) }
    } catch (error) {
      return { ...failure(error), note: null }
    }
  },
  // Rejects on failure, as Electron's `notes:undo-tag-template` handler does.
  undoTagTemplate: async (input: UndoTagTemplateInput): Promise<UndoTagTemplateResponse> => ({
    status: await commands.notesUndoTagTemplate(input)
  }),
  // A failed rename, move or reorder answers as Electron's `registerCommand` does.
  rename: async (id: string, newTitle: string): Promise<NoteUpdateResponse> => {
    try {
      return { success: true, note: toNote(await commands.notesRename(id, newTitle)) }
    } catch (error) {
      return { ...failure(error), note: null }
    }
  },
  // A move whose relative refs could not follow the note still moved it; the user is told
  // the links point from the old folder, which Electron only logs.
  move: async (id: string, newFolder: string): Promise<NoteUpdateResponse> => {
    try {
      const { note, refsKept } = await commands.notesMove(id, newFolder)
      if (refsKept) warnRefsKept(note, refsKept)
      return { success: true, note: toNote(note) }
    } catch (error) {
      return { ...failure(error), note: null }
    }
  },
  reorder: async (folderPath: string, notePaths: string[]) => {
    try {
      await commands.notesReorder(folderPath, notePaths)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  getAllPositions: async () => {
    try {
      return { success: true, positions: await commands.notesGetAllPositions() }
    } catch (error) {
      return { ...failure(error), positions: {} }
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
  linkMention: async ({
    sourceId,
    targetId,
    ordinal
  }: NoteLinkMention): Promise<NoteLinkMentionResponse> => ({
    linked: await commands.notesLinkMention(sourceId, targetId, ordinal)
  }),
  // Rejects on failure, as Electron's `notes:edit-aliases` (`registerCommand`) does.
  editAliases: (input: NoteAliasEdit): Promise<NoteAliasEditResponse> =>
    commands.notesEditAliases(input),
  // Electron's `notes:get-tags` is `tags:get-all-with-counts` (`getAllTagsWithCounts`) in
  // another shape; one owner serves both.
  getTags: async (): Promise<{ tag: string; color: string; count: number }[]> =>
    (await commands.tagsGetAllWithCounts()).map(({ name, color, count }) => ({
      tag: name,
      color,
      count
    })),
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
  getCalendarPropertyNames: (): Promise<string[]> => commands.notesGetCalendarPropertyNames(),
  getVersions: async (noteId: string): Promise<SnapshotListItem[]> =>
    (await commands.notesGetVersions(noteId)).map(toVersion),
  getVersion: async (snapshotId: string): Promise<SnapshotDetail | null> => {
    const version = await commands.notesGetVersion(snapshotId)
    return version && { ...toVersion(version), fileContent: version.fileContent }
  },
  // A failed restore or delete answers as Electron's `withErrorHandler` does.
  restoreVersion: async (snapshotId: string): Promise<RestoreVersionResponse> => {
    try {
      const note = await commands.notesRestoreVersion(snapshotId)
      return { success: true, note: note && toNote(note) }
    } catch (error) {
      return { ...failure(error), note: null }
    }
  },
  deleteVersion: async (snapshotId: string) => {
    try {
      await commands.notesDeleteVersion(snapshotId)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  getFolders: (): Promise<FolderInfo[]> => commands.notesGetFolders(),
  // A failed create, rename or config write answers as Electron's handlers do.
  createFolder: async (path: string) => {
    try {
      await commands.notesCreateFolder(path)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  renameFolder: async (oldPath: string, newPath: string) => {
    try {
      await commands.notesRenameFolder(oldPath, newPath)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  deleteFolder: async (path: string) => {
    try {
      await commands.notesDeleteFolder(path)
      return { success: true }
    } catch (error) {
      // Electron's text for any failed folder delete. The codes it can carry are shared with
      // create, rename and the note delete, so they get no text of their own here.
      log.error('Failed to delete folder', { path, error })
      return { success: false, error: getI18n().t('errors:folder.deleteFailed') }
    }
  },
  revealFolderInFinder: async (folderPath: string): Promise<void> => {
    await commands.notesRevealFolderInFinder(folderPath)
  },
  // The views, formulas, properties and summaries come along, as Electron's read gives them.
  getFolderConfig: async (folderPath: string): Promise<FolderConfig | null> => {
    const config = await commands.notesGetFolderConfig(folderPath)
    if (!config) return null
    const { template, ...rest } = config
    return { ...rest, template: template ?? undefined }
  },
  setFolderConfig: async (folderPath: string, config: FolderConfig) => {
    try {
      await commands.notesSetFolderConfig(folderPath, config)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  getFolderTemplate: (folderPath: string): Promise<string | null> =>
    commands.notesGetFolderTemplate(folderPath),
  // The bytes travel as the raw request body, with the file's size in the meta. A `File` over
  // `MAX_UPLOAD_BODY` goes in parts. Anything else over it is never read: an empty body goes,
  // and Rust refuses it on the size with its localized message. A refused or failed save
  // answers as Electron's `saveAttachment` envelope.
  uploadAttachment: async (
    noteId: string,
    file: AttachmentUploadFile & { size?: number; slice?: SlicedFile['slice'] }
  ): Promise<AttachmentResult> => {
    try {
      const { size, slice } = file
      if (size !== undefined && size > MAX_UPLOAD_BODY && slice) {
        const sliced = { name: file.name, size, slice: slice.bind(file) }
        return { success: true, ...(await uploadInParts(noteId, sliced)) }
      }
      const over = size !== undefined && size > MAX_UPLOAD_BODY
      const bytes = over ? new Uint8Array() : new Uint8Array(await file.arrayBuffer())
      const meta = { noteId, fileName: file.name, size: file.size ?? bytes.length }
      const saved = await invokeBinary<SavedAttachment>('notes_upload_attachment', bytes, meta)
      return { success: true, ...saved }
    } catch (error) {
      return failure(error)
    }
  },
  // Rejects on failure, as Electron's `notes:attachment-rename` handler does.
  renameAttachment: (noteId: string, url: string, newName: string) =>
    commands.notesAttachmentRename(noteId, url, newName),
  // These two reject on failure, as Electron's handlers do.
  listVaultAttachments: () => commands.notesListVaultAttachments(),
  insertExistingAttachment: (noteId: string, ownerNoteId: string, filename: string) =>
    commands.notesInsertExistingAttachment(noteId, ownerNoteId, filename),
  // Answers why nothing was saved, as Electron's `notes:download-attachment-from-url` does.
  downloadAttachmentFromUrl: async (noteId: string, url: string) => {
    const response = await commands.notesDownloadAttachmentFromUrl(noteId, url)
    return response.status === 'saved'
      ? { ok: true as const, ref: response.ref }
      : { ok: false as const, reason: response.reason }
  }
} satisfies Partial<NotesClientAPI>

/** The note methods served from Rust; `window.api.notes` is typed without them. */
export type PortedNoteMethod = keyof typeof ported

/**
 * The large-file viewer's calls: `commands.notesLargeFile*` serve them with a `Channel` per call
 * (`hooks/use-large-file-session.ts`), so neither `window.api.notes` nor this service has them.
 */
export type PortedLargeFileMethod =
  | 'largeFileOpen'
  | 'largeFileReadLines'
  | 'largeFileSearch'
  | 'largeFileClose'

type NotesServiceApi = Omit<NotesClientAPI, PortedLargeFileMethod>

export const notesService: NotesServiceApi = createWindowApiForwarder<
  NotesServiceApi,
  PortedNoteMethod
>(() => window.api.notes, ported)

/**
 * Note events were dropped (`shell/note_events.rs`): whatever the app shows of notes may be
 * stale. Not an Electron channel: Electron sends every event.
 */
export function onNoteEventsDropped(callback: () => void): () => void {
  return subscribeToEvent(events.noteEventsDroppedEvent, () => callback())
}

/**
 * The core kept an outside edit of the note's file as a version, under typing the file did not
 * have yet (`notes:outside-edit-kept`, `shell/note_events.rs`). Not an Electron channel.
 */
export function onNoteOutsideEditKept(callback: (event: { id: string }) => void): () => void {
  return subscribeToEvent(events.noteOutsideEditKeptEvent, callback)
}

/** The subscriptions below that Rust events serve; `window.api` is typed without them. */
export type PortedNoteEvent =
  | 'onNoteCreated'
  | 'onNoteUpdated'
  | 'onNoteDeleted'
  | 'onNoteRenamed'
  | 'onNoteMoved'
  | 'onTagsChanged'

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

/**
 * A note renamed by the app, or its file moved outside it; a rename to a title the file name
 * already says names one path, and `newTitle` is the title the note has now.
 */
export function onNoteRenamed(callback: (event: NoteRenamedEvent) => void): () => void {
  return subscribeToEvent(events.noteRenamedEvent, callback)
}

/**
 * The note index committed links that changed: the notes whose links changed (`sourceIds`) and
 * every note that gained or lost a link to it (`targetIds`). It comes after the rows are written,
 * where a note event comes before, so a links read on it sees the edit.
 */
export function onNoteLinksChanged(callback: (event: NoteLinksChangedEvent) => void): () => void {
  return subscribeToEvent(events.noteLinksChangedEvent, callback)
}

/** The app moved a note to another folder; its title stays. */
export function onNoteMoved(callback: (event: NoteMovedEvent) => void): () => void {
  return subscribeToEvent(events.noteMovedEvent, callback)
}

export function onNoteExternalChange(
  callback: (event: NoteExternalChangeEvent) => void
): () => void {
  return window.api.onNoteExternalChange(callback)
}

/** Something the tag list shows changed (`commands/tags.rs`); the payload is empty. */
export function onTagsChanged(callback: () => void): () => void {
  return subscribeToEvent(events.noteTagsChangedEvent, () => callback())
}

/** Sync changed a folder's settings or removed the folder (`shell/folder_sync.rs`). */
export function onFolderConfigUpdated(
  callback: (event: FolderConfigUpdatedEvent) => void
): () => void {
  return subscribeToEvent(events.folderConfigUpdatedEvent, callback)
}
