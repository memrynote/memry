import type {
  BulkArchiveInput,
  BulkFileInput,
  BulkSnoozeInput,
  BulkTagInput,
  CaptureClipInput,
  CaptureImageInput,
  CaptureLinkInput,
  CapturePdfInput,
  CaptureTextInput,
  CaptureVoiceInput,
  FileItemInput,
  GetFilingHistoryInput,
  GetJobsInput,
  InboxArchivedEvent,
  InboxBulkResponse as BulkResponse,
  InboxCapturePattern as CapturePattern,
  InboxCaptureResponse as CaptureResponse,
  InboxCapturedEvent,
  InboxClientAPI,
  InboxFileResponse as FileResponse,
  InboxFiledEvent,
  InboxFilingHistoryEntry,
  InboxFilingHistoryResponse,
  InboxItem,
  InboxItemListItem,
  InboxJob,
  InboxJobsResponse as JobsResponse,
  InboxListInput,
  InboxListResponse,
  InboxMetadataCompleteEvent,
  InboxProcessingErrorEvent,
  InboxSnoozeDueEvent,
  InboxSnoozedEvent,
  InboxStats,
  InboxSuggestionsResponse as SuggestionsResponse,
  InboxTranscriptionCompleteEvent,
  InboxUpdateInput,
  InboxUpdatedEvent,
  LinkPreviewData,
  ListArchivedInput,
  SnoozeInput
} from '@memry/rpc/inbox'

type FilingHistoryResponse = InboxFilingHistoryResponse

export type {
  BulkArchiveInput,
  BulkFileInput,
  BulkResponse,
  BulkSnoozeInput,
  BulkTagInput,
  CaptureClipInput,
  CaptureImageInput,
  CaptureLinkInput,
  CapturePattern,
  CapturePdfInput,
  CaptureResponse,
  CaptureTextInput,
  CaptureVoiceInput,
  FileItemInput,
  FileResponse,
  FilingHistoryResponse,
  GetFilingHistoryInput,
  GetJobsInput,
  InboxArchivedEvent,
  InboxCapturedEvent,
  InboxClientAPI,
  InboxFiledEvent,
  InboxFilingHistoryEntry,
  InboxFilingHistoryResponse,
  InboxItem,
  InboxItemListItem,
  InboxJob,
  JobsResponse,
  InboxListInput,
  InboxListResponse,
  InboxMetadataCompleteEvent,
  InboxProcessingErrorEvent,
  InboxSnoozeDueEvent,
  InboxSnoozedEvent,
  InboxStats,
  InboxTranscriptionCompleteEvent,
  InboxUpdateInput,
  InboxUpdatedEvent,
  LinkPreviewData,
  ListArchivedInput,
  SnoozeInput,
  SuggestionsResponse
}

export const inboxService: InboxClientAPI = {
  captureText: (input) => window.api.inbox.captureText(input),
  captureLink: (input) => window.api.inbox.captureLink(input),
  previewLink: (url) => window.api.inbox.previewLink(url),
  captureImage: (input) => window.api.inbox.captureImage(input),
  captureVoice: (input) => window.api.inbox.captureVoice(input),
  captureClip: (input) => window.api.inbox.captureClip(input),
  capturePdf: (input) => window.api.inbox.capturePdf(input),
  get: (id) => window.api.inbox.get(id),
  list: (options) => window.api.inbox.list(options),
  update: (input) => window.api.inbox.update(input),
  archive: (id) => window.api.inbox.archive(id),
  file: (input) => window.api.inbox.file(input),
  getSuggestions: (itemId) => window.api.inbox.getSuggestions(itemId),
  trackSuggestion: (input) => window.api.inbox.trackSuggestion(input),
  convertToNote: (itemId) => window.api.inbox.convertToNote(itemId),
  convertToTask: (itemId) => window.api.inbox.convertToTask(itemId),
  linkToNote: (itemId, noteId, tags) => window.api.inbox.linkToNote(itemId, noteId, tags),
  addTag: (itemId, tag) => window.api.inbox.addTag(itemId, tag),
  removeTag: (itemId, tag) => window.api.inbox.removeTag(itemId, tag),
  getTags: () => window.api.inbox.getTags(),
  snooze: (input) => window.api.inbox.snooze(input),
  unsnooze: (itemId) => window.api.inbox.unsnooze(itemId),
  getSnoozed: () => window.api.inbox.getSnoozed(),
  markViewed: (itemId) => window.api.inbox.markViewed(itemId),
  bulkFile: (input) => window.api.inbox.bulkFile(input),
  bulkArchive: (input) => window.api.inbox.bulkArchive(input),
  bulkTag: (input) => window.api.inbox.bulkTag(input),
  bulkSnooze: (input) => window.api.inbox.bulkSnooze(input),
  fileAllStale: () => window.api.inbox.fileAllStale(),
  retryTranscription: (itemId) => window.api.inbox.retryTranscription(itemId),
  retryMetadata: (itemId) => window.api.inbox.retryMetadata(itemId),
  getStats: () => window.api.inbox.getStats(),
  getJobs: (options) => window.api.inbox.getJobs(options),
  getPatterns: () => window.api.inbox.getPatterns(),
  getStaleThreshold: () => window.api.inbox.getStaleThreshold(),
  setStaleThreshold: (days) => window.api.inbox.setStaleThreshold(days),
  listArchived: (options) => window.api.inbox.listArchived(options),
  unarchive: (id) => window.api.inbox.unarchive(id),
  deletePermanent: (id) => window.api.inbox.deletePermanent(id),
  getFilingHistory: (options) => window.api.inbox.getFilingHistory(options),
  undoFile: (id) => window.api.inbox.undoFile(id),
  undoArchive: (id) => window.api.inbox.undoArchive(id)
}

export function onInboxCaptured(callback: (event: InboxCapturedEvent) => void): () => void {
  return window.api.onInboxCaptured(callback)
}

export function onInboxUpdated(callback: (event: InboxUpdatedEvent) => void): () => void {
  return window.api.onInboxUpdated(callback)
}

export function onInboxArchived(callback: (event: InboxArchivedEvent) => void): () => void {
  return window.api.onInboxArchived(callback)
}

export function onInboxFiled(callback: (event: InboxFiledEvent) => void): () => void {
  return window.api.onInboxFiled(callback)
}

export function onInboxSnoozed(callback: (event: InboxSnoozedEvent) => void): () => void {
  return window.api.onInboxSnoozed(callback)
}

export function onInboxSnoozeDue(callback: (event: InboxSnoozeDueEvent) => void): () => void {
  return window.api.onInboxSnoozeDue(callback)
}

export function onInboxTranscriptionComplete(
  callback: (event: InboxTranscriptionCompleteEvent) => void
): () => void {
  return window.api.onInboxTranscriptionComplete(callback)
}

export function onInboxMetadataComplete(
  callback: (event: InboxMetadataCompleteEvent) => void
): () => void {
  return window.api.onInboxMetadataComplete(callback)
}

export function onInboxProcessingError(
  callback: (event: InboxProcessingErrorEvent) => void
): () => void {
  return window.api.onInboxProcessingError(callback)
}

export function getInboxItemIcon(type: InboxItem['type']): string {
  const icons: Record<InboxItem['type'], string> = {
    link: 'Link',
    note: 'FileText',
    image: 'Image',
    voice: 'Mic',
    video: 'Video',
    clip: 'Scissors',
    pdf: 'FileText',
    social: 'Share2',
    reminder: 'Bell'
  }
  return icons[type] || 'File'
}

export function getInboxItemColor(type: InboxItem['type']): string {
  const colors: Record<InboxItem['type'], string> = {
    link: 'text-blue-500',
    note: 'text-amber-500',
    image: 'text-purple-500',
    voice: 'text-red-500',
    video: 'text-indigo-500',
    clip: 'text-green-500',
    pdf: 'text-orange-500',
    social: 'text-cyan-500',
    reminder: 'text-amber-500'
  }
  return colors[type] || 'text-muted-foreground'
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

export function formatCompactDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const day = d.getDate()
  const month = SHORT_MONTHS[d.getMonth()]
  const isCurrentYear = d.getFullYear() === new Date().getFullYear()
  return isCurrentYear ? `${day} ${month}` : `${day} ${month} ${d.getFullYear()}`
}

export function formatTimeAgo(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const ms = Date.now() - d.getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return formatCompactDate(d)
}

export function isItemStale(createdAt: Date | string, thresholdDays: number = 7): boolean {
  const d = typeof createdAt === 'string' ? new Date(createdAt) : createdAt
  const now = new Date()
  const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays > thresholdDays
}
