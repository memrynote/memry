import type {
  ArchivedListInput,
  ArchivedListResponse,
  CapturePattern,
  FilingHistoryInput,
  FilingHistoryResponse,
  InboxItem,
  InboxJobListInput,
  InboxJobsResponse,
  InboxListInput,
  InboxListResponse,
  InboxStats
} from './types.ts'

export interface InboxQueryServices {
  getItem(itemId: string): Promise<InboxItem | null>
  list(input: InboxListInput): Promise<InboxListResponse>
  getJobs(input?: InboxJobListInput): Promise<InboxJobsResponse>
  getTags(): Promise<Array<{ tag: string; count: number }>>
  getStats(): Promise<InboxStats>
  getStaleThreshold(): Promise<number>
  setStaleThreshold(days: number): Promise<{ success: boolean }>
  listArchived(input: ArchivedListInput): Promise<ArchivedListResponse>
  getFilingHistory(input: FilingHistoryInput): Promise<FilingHistoryResponse>
  getPatterns(): Promise<CapturePattern>
}

export interface InboxQueries {
  getItem(itemId: string): Promise<InboxItem | null>
  list(input?: InboxListInput): Promise<InboxListResponse>
  getJobs(input?: InboxJobListInput): Promise<InboxJobsResponse>
  getTags(): Promise<Array<{ tag: string; count: number }>>
  getStats(): Promise<InboxStats>
  getStaleThreshold(): Promise<number>
  setStaleThreshold(days: number): Promise<{ success: boolean }>
  listArchived(input?: ArchivedListInput): Promise<ArchivedListResponse>
  getFilingHistory(input?: FilingHistoryInput): Promise<FilingHistoryResponse>
  getPatterns(): Promise<CapturePattern>
}

export function createInboxQueries(services: InboxQueryServices): InboxQueries {
  return {
    getItem: (itemId) => services.getItem(itemId),
    list: (input = {}) => services.list(input),
    getJobs: (input) => services.getJobs(input),
    getTags: () => services.getTags(),
    getStats: () => services.getStats(),
    getStaleThreshold: () => services.getStaleThreshold(),
    setStaleThreshold: (days) => services.setStaleThreshold(days),
    listArchived: (input = {}) => services.listArchived(input),
    getFilingHistory: (input = {}) => services.getFilingHistory(input),
    getPatterns: () => services.getPatterns()
  }
}
