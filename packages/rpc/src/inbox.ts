import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  defineDomain,
  defineEvent,
  defineMethod,
  type RpcClient,
  type RpcSubscriptions
} from './schema.ts'

type InboxItemType =
  | 'link'
  | 'note'
  | 'image'
  | 'voice'
  | 'video'
  | 'clip'
  | 'pdf'
  | 'social'
  | 'reminder'

type ProcessingStatus = 'pending' | 'processing' | 'complete' | 'failed'
type FilingAction = 'folder' | 'note' | 'linked'
type CaptureSource = 'quick-capture' | 'inline' | 'browser-extension' | 'api' | 'reminder'
export type InboxJobType =
  | 'transcription'
  | 'metadata-scrape'
  | 'duplicate-detection'
  | 'suggestion-generation'
  | 'thumbnail-generation'
export type InboxJobStatus = 'pending' | 'running' | 'failed' | 'complete'

interface ReminderMetadata {
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

type InboxMetadata = Record<string, unknown> | ReminderMetadata

export interface InboxItem {
  id: string
  type: InboxItemType
  title: string
  content: string | null
  createdAt: Date
  modifiedAt: Date
  filedAt: Date | null
  filedTo: string | null
  filedAction: FilingAction | null
  snoozedUntil: Date | null
  snoozeReason: string | null
  viewedAt: Date | null
  processingStatus: ProcessingStatus
  processingError: string | null
  metadata: InboxMetadata | null
  attachmentPath: string | null
  attachmentUrl: string | null
  thumbnailPath: string | null
  thumbnailUrl: string | null
  transcription: string | null
  transcriptionStatus: ProcessingStatus | null
  sourceUrl: string | null
  sourceTitle: string | null
  captureSource?: CaptureSource | null
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
  processingStatus: ProcessingStatus
  duration?: number
  excerpt?: string
  pageCount?: number
  transcription?: string | null
  transcriptionStatus?: ProcessingStatus | null
  snoozedUntil?: Date
  snoozeReason?: string
  viewedAt?: Date
  captureSource?: CaptureSource | null
  metadata?: InboxMetadata
}

export interface InboxListResponse {
  items: InboxItemListItem[]
  total: number
  hasMore: boolean
}

interface InboxDuplicateMatch {
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

export interface InboxFilingSuggestion {
  destination: {
    type: 'folder' | 'note' | 'new-note'
    path?: string
    noteId?: string
    noteTitle?: string
  }
  confidence: number
  reason: string
  suggestedTags: string[]
  suggestedNote?: {
    id: string
    title: string
    snippet: string
    emoji?: string | null
  }
}

export interface InboxSuggestionsResponse {
  suggestions: InboxFilingSuggestion[]
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
  ageDistribution: {
    fresh: number
    aging: number
    stale: number
  }
  oldestItemDays: number
  currentStreak: number
}

export interface InboxCapturePattern {
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

export interface InboxFilingHistoryEntry {
  id: string
  itemId: string
  itemType: InboxItemType
  itemTitle: string
  filedTo: string
  filedAction: FilingAction
  filedAt: Date
  tags: string[]
}

export interface InboxFilingHistoryResponse {
  entries: InboxFilingHistoryEntry[]
}

export interface LinkPreviewData {
  title: string
  domain: string
  favicon?: string
  image?: string
  description?: string
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
  data: ArrayBuffer
  filename: string
  mimeType: string
  tags?: string[]
  source?: CaptureSource
}

export interface CaptureVoiceInput {
  data: ArrayBuffer
  duration: number
  format: string
  transcribe?: boolean
  tags?: string[]
  source?: CaptureSource
}

export interface CaptureClipInput {
  html: string
  text: string
  sourceUrl: string
  sourceTitle: string
  tags?: string[]
  source?: CaptureSource
}

export interface CapturePdfInput {
  data: ArrayBuffer
  filename: string
  extractText?: boolean
  tags?: string[]
}

export interface InboxListInput {
  type?: 'link' | 'note' | 'image' | 'voice' | 'clip' | 'pdf' | 'social' | 'reminder'
  includeSnoozed?: boolean
  sortBy?: 'created' | 'modified' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface InboxUpdateInput {
  id: string
  title?: string
  content?: string
}

export interface FileItemInput {
  itemId: string
  destination: {
    type: 'folder' | 'note' | 'new-note'
    path?: string
    noteId?: string
    noteIds?: string[]
    noteTitle?: string
  }
  tags?: string[]
}

export interface SnoozeInput {
  itemId: string
  snoozeUntil: string
  reason?: string
}

export interface BulkFileInput {
  itemIds: string[]
  destination: {
    type: 'folder' | 'note' | 'new-note'
    path?: string
    noteId?: string
  }
  tags?: string[]
}

export interface BulkArchiveInput {
  itemIds: string[]
}

export interface BulkTagInput {
  itemIds: string[]
  tags: string[]
}

export interface BulkSnoozeInput {
  itemIds: string[]
  snoozeUntil: string
  reason?: string
}

export interface ListArchivedInput {
  search?: string
  limit?: number
  offset?: number
}

export interface GetFilingHistoryInput {
  limit?: number
}

export interface GetJobsInput {
  itemIds?: string[]
  statuses?: InboxJobStatus[]
}

export interface InboxCapturedEvent {
  item: InboxItemListItem
}

export interface InboxUpdatedEvent {
  id: string
  changes: Partial<InboxItem>
}

export interface InboxArchivedEvent {
  id: string
}

export interface InboxFiledEvent {
  id: string
  filedTo: string
  filedAction: string
}

export interface InboxSnoozedEvent {
  id: string
  snoozeUntil: string
}

export interface InboxSnoozeDueEvent {
  items: InboxItemListItem[]
}

export interface InboxTranscriptionCompleteEvent {
  id: string
  transcription: string
}

export interface InboxMetadataCompleteEvent {
  id: string
  metadata: InboxMetadata
}

export interface InboxProcessingErrorEvent {
  id: string
  operation: string
  error: string
}

type SuccessResponse = Promise<{ success: boolean; error?: string }>

export const inboxRpc = defineDomain({
  name: 'inbox',
  methods: {
    captureText: defineMethod<(input: CaptureTextInput) => Promise<InboxCaptureResponse>>({
      channel: InboxChannels.invoke.CAPTURE_TEXT,
      params: ['input']
    }),
    captureLink: defineMethod<(input: CaptureLinkInput) => Promise<InboxCaptureResponse>>({
      channel: InboxChannels.invoke.CAPTURE_LINK,
      params: ['input']
    }),
    previewLink: defineMethod<(url: string) => Promise<LinkPreviewData>>({
      channel: InboxChannels.invoke.PREVIEW_LINK,
      params: ['url']
    }),
    captureImage: defineMethod<(input: CaptureImageInput) => Promise<InboxCaptureResponse>>({
      channel: InboxChannels.invoke.CAPTURE_IMAGE,
      params: ['input']
    }),
    captureVoice: defineMethod<(input: CaptureVoiceInput) => Promise<InboxCaptureResponse>>({
      channel: InboxChannels.invoke.CAPTURE_VOICE,
      params: ['input']
    }),
    captureClip: defineMethod<(input: CaptureClipInput) => Promise<InboxCaptureResponse>>({
      channel: InboxChannels.invoke.CAPTURE_CLIP,
      params: ['input']
    }),
    capturePdf: defineMethod<(input: CapturePdfInput) => Promise<InboxCaptureResponse>>({
      channel: InboxChannels.invoke.CAPTURE_PDF,
      params: ['input']
    }),
    get: defineMethod<(id: string) => Promise<InboxItem | null>>({
      channel: InboxChannels.invoke.GET,
      params: ['id']
    }),
    list: defineMethod<(options?: InboxListInput) => Promise<InboxListResponse>>({
      channel: InboxChannels.invoke.LIST,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    update: defineMethod<(input: InboxUpdateInput) => Promise<InboxCaptureResponse>>({
      channel: InboxChannels.invoke.UPDATE,
      params: ['input']
    }),
    archive: defineMethod<(id: string) => SuccessResponse>({
      channel: InboxChannels.invoke.ARCHIVE,
      params: ['id']
    }),
    file: defineMethod<(input: FileItemInput) => Promise<InboxFileResponse>>({
      channel: InboxChannels.invoke.FILE,
      params: ['input']
    }),
    getSuggestions: defineMethod<(itemId: string) => Promise<InboxSuggestionsResponse>>({
      channel: InboxChannels.invoke.GET_SUGGESTIONS,
      params: ['itemId']
    }),
    trackSuggestion: defineMethod<
      (input: {
        itemId: string
        itemType: string
        suggestedTo: string
        actualTo: string
        confidence: number
        suggestedTags?: string[]
        actualTags?: string[]
      }) => SuccessResponse
    >({
      channel: InboxChannels.invoke.TRACK_SUGGESTION,
      params: ['input'],
      implementation: `(input) =>
        invoke(
          ${JSON.stringify(InboxChannels.invoke.TRACK_SUGGESTION)},
          input.itemId,
          input.itemType,
          input.suggestedTo,
          input.actualTo,
          input.confidence,
          input.suggestedTags ?? [],
          input.actualTags ?? []
        )`
    }),
    convertToNote: defineMethod<(itemId: string) => Promise<InboxFileResponse>>({
      channel: InboxChannels.invoke.CONVERT_TO_NOTE,
      params: ['itemId']
    }),
    convertToTask: defineMethod<
      (itemId: string) => Promise<{ success: boolean; taskId: string | null; error?: string }>
    >({
      channel: InboxChannels.invoke.CONVERT_TO_TASK,
      params: ['itemId']
    }),
    linkToNote: defineMethod<
      (itemId: string, noteId: string, tags?: string[]) => SuccessResponse
    >({
      channel: InboxChannels.invoke.LINK_TO_NOTE,
      params: ['itemId', 'noteId', 'tags'],
      invokeArgs: ['itemId', 'noteId', 'tags ?? []']
    }),
    addTag: defineMethod<(itemId: string, tag: string) => SuccessResponse>({
      channel: InboxChannels.invoke.ADD_TAG,
      params: ['itemId', 'tag']
    }),
    removeTag: defineMethod<(itemId: string, tag: string) => SuccessResponse>({
      channel: InboxChannels.invoke.REMOVE_TAG,
      params: ['itemId', 'tag']
    }),
    getTags: defineMethod<() => Promise<Array<{ tag: string; count: number }>>>({
      channel: InboxChannels.invoke.GET_TAGS
    }),
    snooze: defineMethod<(input: SnoozeInput) => SuccessResponse>({
      channel: InboxChannels.invoke.SNOOZE,
      params: ['input']
    }),
    unsnooze: defineMethod<(itemId: string) => SuccessResponse>({
      channel: InboxChannels.invoke.UNSNOOZE,
      params: ['itemId']
    }),
    getSnoozed: defineMethod<() => Promise<InboxItem[]>>({
      channel: InboxChannels.invoke.GET_SNOOZED
    }),
    markViewed: defineMethod<(itemId: string) => SuccessResponse>({
      channel: InboxChannels.invoke.MARK_VIEWED,
      params: ['itemId']
    }),
    bulkFile: defineMethod<(input: BulkFileInput) => Promise<InboxBulkResponse>>({
      channel: InboxChannels.invoke.BULK_FILE,
      params: ['input']
    }),
    bulkArchive: defineMethod<(input: BulkArchiveInput) => Promise<InboxBulkResponse>>({
      channel: InboxChannels.invoke.BULK_ARCHIVE,
      params: ['input']
    }),
    bulkTag: defineMethod<(input: BulkTagInput) => Promise<InboxBulkResponse>>({
      channel: InboxChannels.invoke.BULK_TAG,
      params: ['input']
    }),
    bulkSnooze: defineMethod<(input: BulkSnoozeInput) => Promise<InboxBulkResponse>>({
      channel: InboxChannels.invoke.BULK_SNOOZE,
      params: ['input']
    }),
    fileAllStale: defineMethod<() => Promise<InboxBulkResponse>>({
      channel: InboxChannels.invoke.FILE_ALL_STALE
    }),
    retryTranscription: defineMethod<(itemId: string) => SuccessResponse>({
      channel: InboxChannels.invoke.RETRY_TRANSCRIPTION,
      params: ['itemId']
    }),
    retryMetadata: defineMethod<(itemId: string) => SuccessResponse>({
      channel: InboxChannels.invoke.RETRY_METADATA,
      params: ['itemId']
    }),
    getStats: defineMethod<() => Promise<InboxStats>>({
      channel: InboxChannels.invoke.GET_STATS
    }),
    getJobs: defineMethod<(options?: GetJobsInput) => Promise<InboxJobsResponse>>({
      channel: InboxChannels.invoke.GET_JOBS,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    getPatterns: defineMethod<() => Promise<InboxCapturePattern>>({
      channel: InboxChannels.invoke.GET_PATTERNS
    }),
    getStaleThreshold: defineMethod<() => Promise<number>>({
      channel: InboxChannels.invoke.GET_STALE_THRESHOLD
    }),
    setStaleThreshold: defineMethod<(days: number) => Promise<{ success: boolean }>>({
      channel: InboxChannels.invoke.SET_STALE_THRESHOLD,
      params: ['days']
    }),
    listArchived: defineMethod<(options?: ListArchivedInput) => Promise<InboxListResponse>>({
      channel: InboxChannels.invoke.LIST_ARCHIVED,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    unarchive: defineMethod<(id: string) => SuccessResponse>({
      channel: InboxChannels.invoke.UNARCHIVE,
      params: ['id']
    }),
    deletePermanent: defineMethod<(id: string) => SuccessResponse>({
      channel: InboxChannels.invoke.DELETE_PERMANENT,
      params: ['id']
    }),
    getFilingHistory: defineMethod<
      (options?: GetFilingHistoryInput) => Promise<InboxFilingHistoryResponse>
    >({
      channel: InboxChannels.invoke.GET_FILING_HISTORY,
      params: ['options'],
      invokeArgs: ['options ?? {}']
    }),
    undoFile: defineMethod<(id: string) => SuccessResponse>({
      channel: InboxChannels.invoke.UNDO_FILE,
      params: ['id']
    }),
    undoArchive: defineMethod<(id: string) => SuccessResponse>({
      channel: InboxChannels.invoke.UNDO_ARCHIVE,
      params: ['id']
    })
  },
  events: {
    onInboxCaptured: defineEvent<InboxCapturedEvent>(InboxChannels.events.CAPTURED),
    onInboxUpdated: defineEvent<InboxUpdatedEvent>(InboxChannels.events.UPDATED),
    onInboxArchived: defineEvent<InboxArchivedEvent>(InboxChannels.events.ARCHIVED),
    onInboxFiled: defineEvent<InboxFiledEvent>(InboxChannels.events.FILED),
    onInboxSnoozed: defineEvent<InboxSnoozedEvent>(InboxChannels.events.SNOOZED),
    onInboxSnoozeDue: defineEvent<InboxSnoozeDueEvent>(InboxChannels.events.SNOOZE_DUE),
    onInboxTranscriptionComplete: defineEvent<InboxTranscriptionCompleteEvent>(
      InboxChannels.events.TRANSCRIPTION_COMPLETE
    ),
    onInboxMetadataComplete: defineEvent<InboxMetadataCompleteEvent>(
      InboxChannels.events.METADATA_COMPLETE
    ),
    onInboxProcessingError: defineEvent<InboxProcessingErrorEvent>(
      InboxChannels.events.PROCESSING_ERROR
    )
  }
})

export type InboxClientAPI = RpcClient<typeof inboxRpc>
export type InboxSubscriptions = RpcSubscriptions<typeof inboxRpc>
