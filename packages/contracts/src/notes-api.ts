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

export interface NoteFrontmatter {
  id: string
  title?: string
  created: string
  modified: string
  tags?: string[]
  aliases?: string[]
  [key: string]: unknown
}

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
}

export interface NoteListItem {
  id: string
  path: string
  title: string
  created: Date
  modified: Date
  tags: string[]
  wordCount: number
  snippet?: string // First 200 chars of content
  emoji?: string | null // Emoji icon for visual identification
  localOnly?: boolean
}

export interface NoteLink {
  sourceId: string
  targetId: string | null
  targetTitle: string
  lineNumber: number
}

export interface Backlink {
  sourceId: string
  sourcePath: string
  sourceTitle: string
  context: string // Surrounding text
  lineNumber: number
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
  offset: z.number().int().min(0).default(0)
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
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface NoteCreatedEvent {
  note: NoteListItem
  source: 'internal' | 'external'
}

export interface NoteUpdatedEvent {
  id: string
  changes: Partial<Note>
  source: 'internal' | 'external'
}

export interface NoteDeletedEvent {
  id: string
  path: string
  source: 'internal' | 'external'
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
}
