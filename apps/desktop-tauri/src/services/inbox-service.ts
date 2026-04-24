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
import { createWindowApiForwarder } from './window-api-forwarder'

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

export const inboxService: InboxClientAPI = createWindowApiForwarder(() => window.api.inbox)

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
