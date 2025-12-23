/**
 * Notes API Contract - Zod Schemas
 * Feature: 003-notes
 * Date: 2025-12-23
 *
 * These schemas define the contract between renderer and main process.
 * Used for validation at IPC boundaries.
 */

import { z } from 'zod'

// =============================================================================
// Property Types
// =============================================================================

export const PropertyTypeSchema = z.enum([
  'text',
  'number',
  'checkbox',
  'date',
  'select',
  'multiselect',
  'url',
  'rating',
])
export type PropertyType = z.infer<typeof PropertyTypeSchema>

export const PropertyValueSchema = z.object({
  name: z.string().min(1).max(100),
  value: z.unknown(),
  type: PropertyTypeSchema,
})
export type PropertyValue = z.infer<typeof PropertyValueSchema>

export const PropertyDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  type: PropertyTypeSchema,
  options: z.array(z.string()).optional(),
  defaultValue: z.string().optional(),
})
export type PropertyDefinition = z.infer<typeof PropertyDefinitionSchema>

// =============================================================================
// Note Schemas
// =============================================================================

export const NoteSchema = z.object({
  id: z.string().length(12),
  path: z.string(),
  title: z.string().min(1).max(255),
  emoji: z.string().optional(),
  content: z.string(),
  tags: z.array(z.string()),
  properties: z.record(z.unknown()).optional(),
  aliases: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  modifiedAt: z.string().datetime(),
})
export type Note = z.infer<typeof NoteSchema>

export const NoteListItemSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  emoji: z.string().optional(),
  snippet: z.string(),
  wordCount: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  modifiedAt: z.string().datetime(),
})
export type NoteListItem = z.infer<typeof NoteListItemSchema>

// =============================================================================
// Link Schemas
// =============================================================================

export const NoteLinkSchema = z.object({
  sourceId: z.string(),
  targetId: z.string().nullable(),
  targetTitle: z.string(),
  exists: z.boolean(),
})
export type NoteLink = z.infer<typeof NoteLinkSchema>

export const BacklinkSchema = z.object({
  sourceId: z.string(),
  sourceTitle: z.string(),
  sourcePath: z.string(),
  context: z.string(),
})
export type Backlink = z.infer<typeof BacklinkSchema>

// =============================================================================
// Tag & Folder Schemas
// =============================================================================

export const TagSchema = z.object({
  name: z.string(),
  count: z.number().int().nonnegative(),
  color: z.string().optional(),
})
export type Tag = z.infer<typeof TagSchema>

export const FolderSchema: z.ZodType<Folder> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    noteCount: z.number().int().nonnegative().optional(),
    children: z.array(FolderSchema).optional(),
  })
)
export interface Folder {
  path: string
  name: string
  noteCount?: number
  children?: Folder[]
}

// =============================================================================
// Attachment Schema
// =============================================================================

export const AttachmentSchema = z.object({
  path: z.string(),
  originalName: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  markdown: z.string(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

// =============================================================================
// Search Schema
// =============================================================================

export const SearchResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  snippet: z.string(),
  score: z.number(),
  tags: z.array(z.string()).optional(),
})
export type SearchResult = z.infer<typeof SearchResultSchema>

// =============================================================================
// Input Schemas
// =============================================================================

export const NoteCreateInputSchema = z.object({
  title: z.string().min(1).max(255).default('Untitled'),
  content: z.string().default(''),
  folder: z.string().optional(),
  tags: z.array(z.string()).optional(),
  emoji: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
})
export type NoteCreateInput = z.infer<typeof NoteCreateInputSchema>

export const NoteUpdateInputSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(255).optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  emoji: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
})
export type NoteUpdateInput = z.infer<typeof NoteUpdateInputSchema>

export const NoteListInputSchema = z.object({
  folder: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sortBy: z.enum(['modified', 'created', 'title']).default('modified'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
})
export type NoteListInput = z.infer<typeof NoteListInputSchema>

export const SetPropertiesInputSchema = z.object({
  id: z.string(),
  properties: z.array(PropertyValueSchema),
})
export type SetPropertiesInput = z.infer<typeof SetPropertiesInputSchema>

export const SearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  folder: z.string().optional(),
})
export type SearchInput = z.infer<typeof SearchInputSchema>

export const UploadAttachmentInputSchema = z.object({
  filePath: z.string(),
  originalName: z.string(),
})
export type UploadAttachmentInput = z.infer<typeof UploadAttachmentInputSchema>

export const NoteRenameInputSchema = z.object({
  id: z.string(),
  newTitle: z.string().min(1).max(255),
})
export type NoteRenameInput = z.infer<typeof NoteRenameInputSchema>

export const NoteMoveInputSchema = z.object({
  id: z.string(),
  newFolder: z.string(),
})
export type NoteMoveInput = z.infer<typeof NoteMoveInputSchema>

export const FolderCreateInputSchema = z.object({
  path: z.string().min(1),
})
export type FolderCreateInput = z.infer<typeof FolderCreateInputSchema>

// =============================================================================
// Response Schemas
// =============================================================================

export const NoteResponseSchema = z.object({
  success: z.boolean(),
  note: NoteSchema.optional(),
  error: z.string().optional(),
})
export type NoteResponse = z.infer<typeof NoteResponseSchema>

export const NoteListResponseSchema = z.object({
  notes: z.array(NoteListItemSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
})
export type NoteListResponse = z.infer<typeof NoteListResponseSchema>

export const TagsResponseSchema = z.object({
  tags: z.array(TagSchema),
})
export type TagsResponse = z.infer<typeof TagsResponseSchema>

export const LinksResponseSchema = z.object({
  outgoing: z.array(NoteLinkSchema),
  incoming: z.array(BacklinkSchema),
})
export type LinksResponse = z.infer<typeof LinksResponseSchema>

export const FoldersResponseSchema = z.object({
  folders: z.array(FolderSchema),
})
export type FoldersResponse = z.infer<typeof FoldersResponseSchema>

export const PropertyDefinitionsResponseSchema = z.object({
  definitions: z.array(PropertyDefinitionSchema),
})
export type PropertyDefinitionsResponse = z.infer<typeof PropertyDefinitionsResponseSchema>

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  total: z.number().int().nonnegative(),
  query: z.string().optional(),
})
export type SearchResponse = z.infer<typeof SearchResponseSchema>

export const AttachmentResponseSchema = z.object({
  success: z.boolean(),
  attachment: AttachmentSchema.optional(),
  error: z.string().optional(),
})
export type AttachmentResponse = z.infer<typeof AttachmentResponseSchema>

export const SuccessResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
})
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>

// =============================================================================
// IPC Event Payloads
// =============================================================================

export const NoteEventSourceSchema = z.enum(['internal', 'external'])
export type NoteEventSource = z.infer<typeof NoteEventSourceSchema>

export const NoteCreatedEventSchema = z.object({
  note: NoteSchema,
  source: NoteEventSourceSchema,
})
export type NoteCreatedEvent = z.infer<typeof NoteCreatedEventSchema>

export const NoteUpdatedEventSchema = z.object({
  note: NoteSchema,
  source: NoteEventSourceSchema,
})
export type NoteUpdatedEvent = z.infer<typeof NoteUpdatedEventSchema>

export const NoteDeletedEventSchema = z.object({
  id: z.string(),
  path: z.string(),
})
export type NoteDeletedEvent = z.infer<typeof NoteDeletedEventSchema>

export const NoteRenamedEventSchema = z.object({
  id: z.string(),
  oldPath: z.string(),
  newPath: z.string(),
  oldTitle: z.string(),
  newTitle: z.string(),
})
export type NoteRenamedEvent = z.infer<typeof NoteRenamedEventSchema>

export const NoteMovedEventSchema = z.object({
  id: z.string(),
  oldPath: z.string(),
  newPath: z.string(),
})
export type NoteMovedEvent = z.infer<typeof NoteMovedEventSchema>

// =============================================================================
// IPC Channel Names
// =============================================================================

export const NotesChannels = {
  invoke: {
    CREATE: 'notes:create',
    GET: 'notes:get',
    GET_BY_PATH: 'notes:get-by-path',
    UPDATE: 'notes:update',
    RENAME: 'notes:rename',
    MOVE: 'notes:move',
    DELETE: 'notes:delete',
    LIST: 'notes:list',
    GET_TAGS: 'notes:get-tags',
    GET_LINKS: 'notes:get-links',
    GET_FOLDERS: 'notes:get-folders',
    CREATE_FOLDER: 'notes:create-folder',
    RENAME_FOLDER: 'notes:rename-folder',
    DELETE_FOLDER: 'notes:delete-folder',
    EXISTS: 'notes:exists',
    OPEN_EXTERNAL: 'notes:open-external',
    REVEAL_IN_FINDER: 'notes:reveal-in-finder',
    SET_PROPERTIES: 'notes:set-properties',
    GET_PROPERTY_DEFINITIONS: 'notes:get-property-definitions',
    UPLOAD_ATTACHMENT: 'notes:upload-attachment',
  },
  events: {
    CREATED: 'notes:created',
    UPDATED: 'notes:updated',
    DELETED: 'notes:deleted',
    RENAMED: 'notes:renamed',
    MOVED: 'notes:moved',
    EXTERNAL_CHANGE: 'notes:external-change',
  },
} as const

export const SearchChannels = {
  invoke: {
    QUERY: 'search:query',
    QUICK: 'search:quick',
    STATS: 'search:stats',
  },
} as const
