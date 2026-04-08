import type { SyncItemType } from '@memry/contracts/sync-api'

import { createLogger } from '../lib/logger'
import type { RecordPushBatchOutcome } from './sync'

type SyncTransport = 'record' | 'crdt'
type RecordQueryOperation = 'changes' | 'pull'
type SyncDomain =
  | 'notes'
  | 'tasks'
  | 'projects'
  | 'settings'
  | 'inbox'
  | 'filters'
  | 'attachments'
  | 'tags'

const logger = createLogger('SyncTelemetry')

const LATENCY_BUCKETS = [
  { max: 25, bucket: 'under_25ms' },
  { max: 100, bucket: '25_to_99ms' },
  { max: 250, bucket: '100_to_249ms' },
  { max: 1000, bucket: '250_to_999ms' }
] as const

const toSyncDomain = (itemType: SyncItemType): SyncDomain => {
  switch (itemType) {
    case 'note':
    case 'journal':
      return 'notes'
    case 'task':
      return 'tasks'
    case 'project':
      return 'projects'
    case 'settings':
      return 'settings'
    case 'inbox':
      return 'inbox'
    case 'filter':
      return 'filters'
    case 'attachment':
      return 'attachments'
    case 'tag_definition':
      return 'tags'
  }
}

const toLatencyBucket = (latencyMs: number): string => {
  for (const entry of LATENCY_BUCKETS) {
    if (latencyMs < entry.max) {
      return entry.bucket
    }
  }

  return '1s_plus'
}

const summarizeItemTypes = (itemTypes: SyncItemType[]): Partial<Record<SyncDomain, number>> => {
  const summary: Partial<Record<SyncDomain, number>> = {}
  for (const itemType of itemTypes) {
    const domain = toSyncDomain(itemType)
    summary[domain] = (summary[domain] ?? 0) + 1
  }
  return summary
}

export const logSyncValidationFailure = (params: {
  transport: SyncTransport
  endpoint: string
  issue: string
}): void => {
  logger.warn('Sync request validation failed', params)
}

export const logRecordPushBatch = (params: {
  endpoint: string
  latencyMs: number
  outcomes: RecordPushBatchOutcome[]
}): void => {
  const domains: Partial<
    Record<
      SyncDomain,
      {
        accepted: number
        rejected: number
        replayRejected: number
        conflictRejected: number
        quotaRejected: number
        otherRejected: number
      }
    >
  > = {}

  let accepted = 0
  let rejected = 0

  for (const outcome of params.outcomes) {
    const domain = toSyncDomain(outcome.type)
    const entry = domains[domain] ?? {
      accepted: 0,
      rejected: 0,
      replayRejected: 0,
      conflictRejected: 0,
      quotaRejected: 0,
      otherRejected: 0
    }

    if (outcome.accepted) {
      entry.accepted += 1
      accepted += 1
    } else {
      entry.rejected += 1
      rejected += 1
      switch (outcome.reason) {
        case 'SYNC_REPLAY_DETECTED':
          entry.replayRejected += 1
          break
        case 'SYNC_VERSION_CONFLICT':
          entry.conflictRejected += 1
          break
        case 'STORAGE_QUOTA_EXCEEDED':
          entry.quotaRejected += 1
          break
        default:
          entry.otherRejected += 1
      }
    }

    domains[domain] = entry
  }

  logger.info('Record sync push processed', {
    transport: 'record',
    operation: 'push',
    endpoint: params.endpoint,
    accepted,
    rejected,
    totalMutations: params.outcomes.length,
    domains,
    latencyMs: params.latencyMs,
    latencyBucket: toLatencyBucket(params.latencyMs)
  })
}

export const logRecordQueryBatch = (params: {
  endpoint: string
  operation: RecordQueryOperation
  latencyMs: number
  itemTypes: SyncItemType[]
  deletedCount?: number
}): void => {
  logger.info('Record sync query processed', {
    transport: 'record',
    operation: params.operation,
    endpoint: params.endpoint,
    itemCount: params.itemTypes.length,
    deletedCount: params.deletedCount ?? 0,
    domains: summarizeItemTypes(params.itemTypes),
    latencyMs: params.latencyMs,
    latencyBucket: toLatencyBucket(params.latencyMs)
  })
}

export const logCrdtTraffic = (params: {
  endpoint: string
  event:
    | 'updates_stored'
    | 'updates_rejected'
    | 'updates_fetched'
    | 'snapshot_stored'
    | 'snapshot_rejected'
    | 'snapshot_fetched'
    | 'batch_fetched'
  noteId?: string
  updateCount?: number
  noteCount?: number
  totalBytes?: number
  sequenceNum?: number
  latencyMs: number
  reason?: string
}): void => {
  logger.info('CRDT sync activity', {
    transport: 'crdt',
    domain: 'notes',
    ...params,
    latencyBucket: toLatencyBucket(params.latencyMs)
  })
}
