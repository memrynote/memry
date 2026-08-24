/**
 * Platform-free service contracts for app-core modules whose implementations
 * are node-bound (fs-backed notes/inbox/templates). Extracted so pure modules
 * (graph, search-tools, tags) and, later, mobile-bound code can depend on the
 * contracts without reaching the node implementations.
 */


export interface NoteRecord {
  id: string
  path: string
  title: string
  content: string
  tags: string[]
  properties: Record<string, unknown>
  emoji: string | null
  localOnly: boolean
  createdAt: string
  modifiedAt: string
  journalDate: string | null
  wordCount: number
  snippet: string
}

export interface CreateNoteInput {
  title: string
  content?: string
  folder?: string
  tags?: string[]
  properties?: Record<string, unknown>
}

export interface UpdateNoteInput {
  id: string
  title?: string
  content?: string
  append?: string
  tags?: string[]
  properties?: Record<string, unknown>
}

export interface NoteLinkRecord {
  title: string
  noteId: string | null
  path: string | null
}

export interface NoteLinksResponse {
  outgoing: NoteLinkRecord[]
  backlinks: Array<{ id: string; title: string; path: string }>
}

export interface NotePreviewRecord {
  id: string
  title: string
  emoji: string | null
  snippet: string
  tags: Array<{ name: string; color: string }>
  createdAt: string
}

export interface ResolvedNoteRecord {
  id: string
  path: string
  title: string
  fileType: string
}

export interface ResolvedWikiTargetRecord extends ResolvedNoteRecord {
  /** The heading `[[Note#Heading]]` addresses, or `null` when it names none. */
  heading: string | null
}

export interface NotesService {
  create(input: CreateNoteInput): Promise<NoteRecord>
  get(idOrPath: string): Promise<NoteRecord | null>
  list(options?: { folder?: string; journalOnly?: boolean; limit?: number }): Promise<NoteRecord[]>
  update(input: UpdateNoteInput): Promise<NoteRecord>
  exists(idOrPath: string): Promise<boolean>
  rename(idOrPath: string, newTitle: string): Promise<NoteRecord>
  move(idOrPath: string, newFolder: string): Promise<NoteRecord>
  getLinks(idOrPath: string): Promise<NoteLinksResponse>
  previewByTitle(title: string): Promise<NotePreviewRecord | null>
  resolveByTitle(title: string): Promise<ResolvedNoteRecord | null>
  resolveWikiTarget(target: string): Promise<ResolvedWikiTargetRecord | null>
  setLocalOnly(idOrPath: string, localOnly: boolean): Promise<NoteRecord>
  localOnlyCount(): Promise<{ count: number }>
  delete(idOrPath: string): Promise<boolean>
  getJournalByDate(date: string): Promise<NoteRecord | null>
  upsertJournal(date: string, content: string, mode: 'write' | 'append'): Promise<NoteRecord>
}


export interface InboxRecord {
  id: string
  type: string
  title: string
  content: string | null
  createdAt: string
  modifiedAt: string
  filedAt: string | null
  filedTo: string | null
  filedAction: string | null
  archivedAt: string | null
  viewedAt: string | null
  snoozedUntil: string | null
  snoozeReason: string | null
  processingStatus: string | null
  sourceUrl: string | null
  sourceTitle: string | null
  metadata: unknown | null
  attachmentPath: string | null
  thumbnailPath: string | null
  tags: string[]
}

export interface CaptureTextInput {
  title?: string
  content: string
  tags?: string[]
}

export interface CaptureLinkInput {
  url: string
  tags?: string[]
}

export interface CaptureFileInput {
  filePath: string
  mimeType?: string
  title?: string
  tags?: string[]
}

export interface UpdateInboxInput {
  title?: string
  content?: string | null
}

export interface InboxFileResponse {
  success: boolean
  filedTo: string | null
  noteId?: string
  taskId?: string
  error?: string
}

export interface InboxBulkResponse {
  success: boolean
  processedCount: number
  errors: Array<{ itemId: string; error: string }>
}

export interface InboxFilingHistoryEntry {
  id: string
  itemId: string
  itemType: string
  itemTitle: string
  filedTo: string
  filedAction: string
  filedAt: string
  tags: string[]
}

export interface InboxCapturePattern {
  timeHeatmap: number[][]
  typeDistribution: Array<{ type: string; count: number; percentage: number; trend: 'stable' }>
  topDomains: Array<{ domain: string; count: number }>
  topTags: Array<{ tag: string; count: number }>
}

export interface InboxService {
  captureText(input: CaptureTextInput): Promise<InboxRecord>
  captureLink(input: CaptureLinkInput): Promise<InboxRecord>
  captureFile(input: CaptureFileInput): Promise<InboxRecord>
  get(id: string): Promise<InboxRecord | null>
  list(options?: {
    includeArchived?: boolean
    includeSnoozed?: boolean
  }): Promise<{ items: InboxRecord[]; total: number }>
  tags(): Promise<Array<{ tag: string; count: number }>>
  stats(): Promise<{
    totalItems: number
    archivedCount: number
    snoozedCount: number
    viewedCount: number
    itemsByType: Record<string, number>
  }>
  archived(options?: {
    search?: string
    limit?: number
    offset?: number
  }): Promise<{ items: InboxRecord[]; total: number; hasMore: boolean }>
  filingHistory(options?: { limit?: number }): Promise<{ entries: InboxFilingHistoryEntry[] }>
  patterns(): Promise<InboxCapturePattern>
  getStaleThreshold(): Promise<number>
  setStaleThreshold(days: number): Promise<{ success: boolean }>
  update(id: string, input: UpdateInboxInput): Promise<InboxRecord>
  archive(id: string): Promise<InboxRecord>
  unarchive(id: string): Promise<InboxRecord>
  convertToNote(id: string): Promise<InboxFileResponse>
  convertToTask(id: string): Promise<InboxFileResponse>
  linkToNote(
    id: string,
    noteId: string,
    tags?: string[]
  ): Promise<{ success: boolean; error?: string }>
  snooze(id: string, until: string, reason?: string): Promise<InboxRecord>
  unsnooze(id: string): Promise<InboxRecord>
  snoozed(): Promise<{ items: InboxRecord[]; total: number }>
  bulkArchive(ids: string[]): Promise<InboxBulkResponse>
  bulkSnooze(ids: string[], until: string, reason?: string): Promise<InboxBulkResponse>
  bulkTag(ids: string[], tags: string[]): Promise<InboxBulkResponse>
  deletePermanent(id: string): Promise<boolean>
  addTag(id: string, tag: string): Promise<InboxRecord>
  removeTag(id: string, tag: string): Promise<InboxRecord>
  markViewed(id: string): Promise<InboxRecord>
}


export interface TemplateProperty {
  name: string
  type: string
  value: unknown
  options?: string[]
}

export interface TemplateRecord {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
  tags: string[]
  properties: TemplateProperty[]
  content: string
  path: string
  createdAt: string
  modifiedAt: string
}

export interface CreateTemplateInput {
  name: string
  description?: string
  icon?: string | null
  tags?: string[]
  properties?: TemplateProperty[]
  content?: string
}

export interface UpdateTemplateInput {
  name?: string
  description?: string
  icon?: string | null
  tags?: string[]
  properties?: TemplateProperty[]
  content?: string
}

export interface TemplatesService {
  list(): Promise<TemplateRecord[]>
  get(id: string): Promise<TemplateRecord | null>
  create(input: CreateTemplateInput): Promise<TemplateRecord>
  update(id: string, input: UpdateTemplateInput): Promise<TemplateRecord>
  duplicate(id: string, newName: string): Promise<TemplateRecord>
  delete(id: string): Promise<boolean>
}
