export type InboxItemType =
  | 'link'
  | 'note'
  | 'image'
  | 'voice'
  | 'video'
  | 'clip'
  | 'pdf'
  | 'social'
  | 'reminder'

export type InboxProcessingStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type InboxFilingAction = 'folder' | 'note' | 'linked'
export type CaptureSource = 'quick-capture' | 'inline' | 'browser-extension' | 'api' | 'reminder'
export type InboxJobType =
  | 'transcription'
  | 'metadata-scrape'
  | 'duplicate-detection'
  | 'suggestion-generation'
  | 'thumbnail-generation'
export type InboxJobStatus = 'pending' | 'running' | 'failed' | 'complete'
export type TriageAction = 'discard' | 'convert-to-task' | 'expand-to-note' | 'file' | 'defer'

export interface LinkMetadata {
  url: string
  siteName?: string
  description?: string
  excerpt?: string
  heroImage?: string | null
  favicon?: string | null
  author?: string
  publishedDate?: string
  fetchedAt?: string
  fetchStatus: 'pending' | 'success' | 'partial' | 'failed'
}

export interface ImageMetadata {
  originalFilename: string
  format: string
  width: number
  height: number
  fileSize: number
  hasExif: boolean
  caption?: string
}

export interface VoiceMetadata {
  duration: number
  format: string
  fileSize: number
  sampleRate?: number
}

export interface ClipMetadata {
  sourceUrl: string
  sourceTitle: string
  quotedText: string
  selectionContext?: string
  capturedImages: string[]
  hasFormatting: boolean
}

export interface PdfMetadata {
  originalFilename: string
  pageCount: number
  fileSize: number
  extractedTitle?: string
  author?: string
  creationDate?: string
  textExcerpt?: string
  hasText: boolean
  ocrStatus?: InboxProcessingStatus | 'skipped'
  isPasswordProtected?: boolean
}

export interface SocialMetadata {
  platform: 'twitter' | 'other'
  tweetId?: string
  postUrl: string
  authorName: string
  authorHandle: string
  authorAvatar?: string
  postContent: string
  timestamp?: string
  mediaUrls: string[]
  metrics?: {
    likes?: number
    reposts?: number
    replies?: number
  }
  isThread?: boolean
  threadId?: string
  extractionStatus: 'pending' | 'full' | 'partial' | 'failed'
}

export interface ReminderMetadata {
  reminderId: string
  targetType: 'note' | 'journal' | 'highlight'
  targetId: string
  targetTitle: string | null
  remindAt: string
  highlightText?: string
  highlightStart?: number
  highlightEnd?: number
  reminderNote?: string
}

export type InboxMetadata =
  | LinkMetadata
  | ImageMetadata
  | VoiceMetadata
  | ClipMetadata
  | PdfMetadata
  | SocialMetadata
  | ReminderMetadata
  | Record<string, unknown>

export interface InboxItem {
  id: string
  type: InboxItemType
  title: string
  content: string | null
  createdAt: Date
  modifiedAt: Date
  filedAt: Date | null
  filedTo: string | null
  filedAction: InboxFilingAction | null
  snoozedUntil: Date | null
  snoozeReason: string | null
  viewedAt: Date | null
  archivedAt: Date | null
  processingStatus: InboxProcessingStatus
  processingError: string | null
  metadata: InboxMetadata | null
  attachmentPath: string | null
  attachmentUrl: string | null
  thumbnailPath: string | null
  thumbnailUrl: string | null
  transcription: string | null
  transcriptionStatus: InboxProcessingStatus | null
  sourceUrl: string | null
  sourceTitle: string | null
  captureSource: CaptureSource | null
  tags: string[]
  isStale: boolean
}

export interface InboxItemListItem {
  id: string
  type: InboxItemType
  title: string
  content: string | null
  createdAt: Date
  thumbnailUrl: string | null
  sourceUrl: string | null
  tags: string[]
  isStale: boolean
  processingStatus: InboxProcessingStatus
  duration?: number
  excerpt?: string
  pageCount?: number
  transcription?: string | null
  transcriptionStatus?: InboxProcessingStatus | null
  snoozedUntil?: Date
  snoozeReason?: string
  viewedAt?: Date
  captureSource?: CaptureSource | null
  metadata?: ReminderMetadata
}

export interface FilingDestination {
  type: 'folder' | 'note' | 'new-note'
  path?: string
  noteId?: string
  noteIds?: string[]
  noteTitle?: string
}

export interface SuggestedNote {
  id: string
  title: string
  snippet: string
  emoji?: string | null
}

export interface InboxFilingSuggestion {
  destination: FilingDestination
  confidence: number
  reason: string
  suggestedTags: string[]
  suggestedNote?: SuggestedNote
}

export interface InboxDuplicateMatch {
  id: string
  title: string
  createdAt: string
}

export interface InboxCaptureResponse {
  success: boolean
  item: InboxItem | null
  error?: string
  duplicate?: boolean
  existingItem?: InboxDuplicateMatch
}

export interface InboxFileResponse {
  success: boolean
  filedTo: string | null
  noteId?: string
  error?: string
}

export interface InboxBulkResponse {
  success: boolean
  processedCount: number
  errors: Array<{ itemId: string; error: string }>
}

export interface InboxSuggestionsResponse {
  suggestions: InboxFilingSuggestion[]
}

export interface InboxJobRecord {
  id: string
  itemId: string
  type: InboxJobType
  status: InboxJobStatus
  runAt: string
  attempts: number
  maxAttempts: number
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  lastError: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InboxJob {
  id: string
  itemId: string
  type: InboxJobType
  status: InboxJobStatus
  runAt: Date
  attempts: number
  maxAttempts: number
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  lastError: string | null
  startedAt: Date | null
  completedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface InboxJobsResponse {
  jobs: InboxJob[]
}

export interface InboxAgeDistribution {
  fresh: number
  aging: number
  stale: number
}

export interface InboxStats {
  totalItems: number
  itemsByType: Record<InboxItemType, number>
  staleCount: number
  snoozedCount: number
  processedToday: number
  capturedToday: number
  avgTimeToProcess: number
  capturedThisWeek: number
  processedThisWeek: number
  captureProcessRatio: number
  ageDistribution: InboxAgeDistribution
  oldestItemDays: number
  currentStreak: number
}

export interface CapturePattern {
  timeHeatmap: number[][]
  typeDistribution: Array<{
    type: InboxItemType
    count: number
    percentage: number
    trend: 'up' | 'down' | 'stable'
  }>
  topDomains: Array<{ domain: string; count: number }>
  topTags: Array<{ tag: string; count: number }>
}

export interface InboxListResponse {
  items: InboxItemListItem[]
  total: number
  hasMore: boolean
}

export interface ArchivedListResponse {
  items: InboxItemListItem[]
  total: number
  hasMore: boolean
}

export interface InboxFilingHistoryEntry {
  id: string
  itemId: string
  itemType: InboxItemType
  itemTitle: string
  filedTo: string
  filedAction: InboxFilingAction
  filedAt: Date
  tags: string[]
}

export interface FilingHistoryResponse {
  entries: InboxFilingHistoryEntry[]
}

export interface TriageState {
  currentIndex: number
  totalItems: number
  currentItem: InboxItem | null
  completedCount: number
}

export interface CaptureTextInput {
  content: string
  title?: string
  tags?: string[]
  force?: boolean
  source?: CaptureSource
}

export interface CaptureLinkInput {
  url: string
  tags?: string[]
  force?: boolean
  source?: CaptureSource
}

export interface CaptureImageInput {
  data: Buffer | Uint8Array | ArrayBuffer | Record<string, unknown>
  filename: string
  mimeType: string
  tags?: string[]
  source?: CaptureSource
}

export interface CaptureVoiceInput {
  data: Buffer | Uint8Array | ArrayBuffer | Record<string, unknown>
  duration: number
  format: 'webm' | 'mp3' | 'wav'
  transcribe?: boolean
  tags?: string[]
  source?: CaptureSource
}

export interface FileItemInput {
  itemId: string
  destination: FilingDestination
  tags?: string[]
}

export interface SnoozeInput {
  itemId: string
  snoozeUntil: string
  reason?: string
}

export interface SnoozedItem {
  id: string
  type: string
  title: string
  content: string | null
  createdAt: Date
  snoozedUntil: Date
  snoozeReason: string | null
  thumbnailUrl: string | null
  sourceUrl: string | null
  tags: string[]
}

export interface TrackSuggestionFeedbackInput {
  itemId: string
  itemType: string
  suggestedTo: string
  actualTo: string
  confidence: number
  suggestedTags?: string[]
  actualTags?: string[]
}

export interface InboxListInput {
  type?: InboxItemType
  includeSnoozed?: boolean
  sortBy?: 'created' | 'modified' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface InboxJobListInput {
  itemIds?: string[]
  statuses?: InboxJobStatus[]
}

export interface ArchivedListInput {
  search?: string
  limit?: number
  offset?: number
}

export interface FilingHistoryInput {
  limit?: number
}

export interface InboxEventMap {
  itemCaptured: { item: InboxItemListItem }
  itemUpdated: { id: string; changes: Record<string, unknown> }
  itemArchived: { id: string }
  itemFiled: { id: string; filedTo: string; filedAction: InboxFilingAction }
  itemSnoozed: { id: string; snoozeUntil: string }
  itemSnoozeDue: { id: string }
  metadataCompleted: { id: string; metadata: Record<string, unknown> }
  transcriptionCompleted: { id: string; transcription: string }
  processingError: { id: string; operation: string; error: string }
  jobQueued: { job: InboxJobRecord }
}
