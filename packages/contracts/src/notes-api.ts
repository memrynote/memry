/**
 * Notes IPC API Contract
 *
 * Handles note CRUD operations, frontmatter management, and file operations.
 * Notes are stored as markdown files; this API bridges file system to renderer.
 */

import { z } from 'zod'

// Import and re-export channels from the contract-local surface.
import { NotesChannels } from './ipc-channels'
export { NotesChannels }

// ============================================================================
// Types
// ============================================================================

/**
 * Raw user frontmatter keys of a note. Every key is a plain user property;
 * only `tags`/`aliases` carry Memry-read semantics. Identity, title, and
 * dates are top-level `Note` fields sourced from the sidecar DBs.
 */
export interface NoteFrontmatter {
  tags?: string[]
  aliases?: string[]
  [key: string]: unknown
}

/**
 * Whether a vault file may be opened as an editable, CRDT-seeded note.
 *
 * Mirrors `MarkdownSizeClass` / `LargeFileReason` in `@memry/shared`, which owns
 * the classifier. Contracts does not depend on shared, so the unions are
 * restated here and their agreement is gated by a parity test in the desktop
 * app, which depends on both.
 */
export type NoteSizeClass = 'note' | 'large-file'
export type NoteLargeFileReason = 'file-bytes' | 'block-bytes'

export interface Note {
  id: string
  path: string // Relative to vault root
  title: string
  content: string
  frontmatter: NoteFrontmatter
  created: Date
  modified: Date
  tags: string[]
  aliases: string[]
  wordCount: number
  emoji?: string | null // Emoji icon for visual identification
  /**
   * Absent on notes written by older app versions, which is read as `'note'`.
   * `'large-file'` means the file is too big, or holds too large a single block,
   * to run through the BlockNote parser — it opens read-only instead.
   */
  sizeClass?: NoteSizeClass
  /** Which bound put the file in `'large-file'`; null for note class. */
  largeFileReason?: NoteLargeFileReason | null
  /**
   * True when `content` is empty because the body was deliberately not
   * delivered, not because the file is empty. Always set for `'large-file'`.
   */
  contentOmitted?: boolean
}

/**
 * A row of `notes:list`.
 *
 * The optional fields are the ones `NoteListFields` controls: with
 * `fields: 'tree'` the main process omits `snippet` (and the file-metadata
 * pair on the main-side row type) because the sidebar tree never reads them,
 * and a whole-vault sidebar fetch would otherwise ship ~200 chars of snippet
 * per note across IPC on every list invalidation. Every field a caller can
 * rely on unconditionally stays required, so `'tree'` rows are still ordinary
 * `NoteListItem`s and no existing consumer needs a guard.
 */
export interface NoteListItem {
  id: string
  path: string
  title: string
  created: Date
  modified: Date
  tags: string[]
  wordCount: number
  snippet?: string // First 200 chars of content — omitted when fields: 'tree'
  emoji?: string | null // Emoji icon for visual identification
  localOnly?: boolean
}

/**
 * Which per-note fields `notes:list` should build.
 *
 * - `full` (default, and what every pre-existing caller gets by omitting it):
 *   the complete `NoteListItem`.
 * - `tree`: identity + what the sidebar renders (path, title, modified, tags,
 *   emoji, localOnly, fileType). Heavy display-only fields are left off.
 */
export type NoteListFields = 'full' | 'tree'

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
  via?: { kind: 'property'; propertyName: string }
}

// ============================================================================
// Request Schemas
// ============================================================================

export const NoteCreateSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().default(''),
  folder: z.string().optional(), // Subfolder path relative to notes/
  tags: z.array(z.string().max(50)).max(50).optional(),
  template: z.string().optional() // Template ID to use
})

export const NoteUpdateSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  content: z.string().optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  frontmatter: z.record(z.string(), z.unknown()).optional(), // Custom frontmatter fields
  emoji: z.string().nullable().optional() // Emoji icon for visual identification
})

export const NoteRenameSchema = z.object({
  id: z.string(),
  newTitle: z.string().min(1).max(200)
})

export const NoteMoveSchema = z.object({
  id: z.string(),
  newFolder: z.string() // Relative path from notes/
})

export const NoteListSchema = z.object({
  folder: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sortBy: z.enum(['modified', 'created', 'title', 'position']).default('modified'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(10000).default(100),
  offset: z.number().int().min(0).default(0),
  // Optional (not `.default()`) on purpose: an older renderer omits it and the
  // handler still resolves to the full shape, so the payload an existing
  // caller receives is byte-identical to before this field existed.
  fields: z.enum(['full', 'tree']).optional()
})

export const NoteReorderSchema = z.object({
  folderPath: z.string(),
  notePaths: z.array(z.string())
})

export const NoteGetPositionsSchema = z.object({
  folderPath: z.string()
})

export const SetLocalOnlySchema = z.object({
  id: z.string(),
  localOnly: z.boolean()
})

export const ApplyTemplateSchema = z.object({
  noteId: z.string(),
  templateId: z.string(),
  mode: z.enum(['full', 'body'])
})

// ============================================================================
// Response Types
// ============================================================================

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

export interface NoteLinksResponse {
  outgoing: NoteLink[]
  incoming: Backlink[]
}

// ============================================================================
// Handler Signatures
// ============================================================================

export interface NotesHandlers {
  [NotesChannels.invoke.CREATE]: (
    input: z.infer<typeof NoteCreateSchema>
  ) => Promise<NoteCreateResponse>

  [NotesChannels.invoke.GET]: (id: string) => Promise<Note | null>

  [NotesChannels.invoke.GET_BY_PATH]: (path: string) => Promise<Note | null>

  [NotesChannels.invoke.UPDATE]: (
    input: z.infer<typeof NoteUpdateSchema>
  ) => Promise<NoteUpdateResponse>

  [NotesChannels.invoke.RENAME]: (
    input: z.infer<typeof NoteRenameSchema>
  ) => Promise<NoteUpdateResponse>

  [NotesChannels.invoke.MOVE]: (
    input: z.infer<typeof NoteMoveSchema>
  ) => Promise<NoteUpdateResponse>

  [NotesChannels.invoke.DELETE]: (id: string) => Promise<{ success: boolean; error?: string }>

  [NotesChannels.invoke.LIST]: (input: z.infer<typeof NoteListSchema>) => Promise<NoteListResponse>

  [NotesChannels.invoke.GET_TAGS]: () => Promise<{ tag: string; color: string; count: number }[]>

  [NotesChannels.invoke.GET_LINKS]: (id: string) => Promise<NoteLinksResponse>

  [NotesChannels.invoke.GET_FOLDERS]: () => Promise<string[]>

  [NotesChannels.invoke.CREATE_FOLDER]: (path: string) => Promise<{ success: boolean }>

  [NotesChannels.invoke.RENAME_FOLDER]: (
    oldPath: string,
    newPath: string
  ) => Promise<{ success: boolean }>

  [NotesChannels.invoke.EXISTS]: (titleOrPath: string) => Promise<boolean>

  [NotesChannels.invoke.OPEN_EXTERNAL]: (id: string) => Promise<void>

  [NotesChannels.invoke.REVEAL_IN_FINDER]: (id: string) => Promise<void>

  [NotesChannels.invoke.APPLY_TEMPLATE]: (
    input: z.infer<typeof ApplyTemplateSchema>
  ) => Promise<NoteUpdateResponse>
}

// ============================================================================
// Event Payloads
// ============================================================================

/**
 * Who produced a note event. `sync` is a remote pull or CRDT write-back
 * landing on this device — it has always been emitted at runtime, the union
 * just never admitted it.
 */
export type NoteEventSource = 'internal' | 'external' | 'sync'

export interface NoteCreatedEvent {
  note: NoteListItem
  source: NoteEventSource
}

export interface NoteUpdatedEvent {
  id: string
  /**
   * The fields this event actually changed. Always present — subscribers read
   * it without guarding, so an emitter that omits it throws in the renderer.
   */
  changes: Partial<Note>
  source: NoteEventSource
}

export interface NoteDeletedEvent {
  id: string
  path: string
  source: NoteEventSource
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

// ============================================================================
// Client API
// ============================================================================

/**
 * Notes service client interface for renderer process
 *
 * @example
 * ```typescript
 * const notes = window.api.notes;
 *
 * // Create a note
 * const result = await notes.create({
 *   title: 'My New Note',
 *   content: '# Hello\n\nThis is my note.',
 *   tags: ['work', 'important']
 * });
 *
 * // List notes
 * const { notes, total } = await notes.list({
 *   sortBy: 'modified',
 *   limit: 50
 * });
 *
 * // Listen for external changes
 * window.api.on('notes:external-change', ({ id, type }) => {
 *   if (type === 'modified' && id === currentNoteId) {
 *     reloadCurrentNote();
 *   }
 * });
 * ```
 */
export interface NotesClientAPI {
  create(input: z.infer<typeof NoteCreateSchema>): Promise<NoteCreateResponse>
  get(id: string): Promise<Note | null>
  getByPath(path: string): Promise<Note | null>
  update(input: z.infer<typeof NoteUpdateSchema>): Promise<NoteUpdateResponse>
  rename(id: string, newTitle: string): Promise<NoteUpdateResponse>
  move(id: string, newFolder: string): Promise<NoteUpdateResponse>
  delete(id: string): Promise<{ success: boolean; error?: string }>
  list(options?: z.infer<typeof NoteListSchema>): Promise<NoteListResponse>
  getTags(): Promise<{ tag: string; color: string; count: number }[]>
  getLinks(id: string): Promise<NoteLinksResponse>
  getFolders(): Promise<string[]>
  createFolder(path: string): Promise<{ success: boolean }>
  exists(titleOrPath: string): Promise<boolean>
  openExternal(id: string): Promise<void>
  revealInFinder(id: string): Promise<void>
  applyTemplate(input: z.infer<typeof ApplyTemplateSchema>): Promise<NoteUpdateResponse>
}
