import type { VectorClock, FieldClocks } from '@shared/contracts/sync-api'
import { merge as mergeClock } from './vector-clock'
import { createLogger } from '../lib/logger'

const log = createLogger('FieldMerge')

export type { FieldClocks }

export const TASK_SYNCABLE_FIELDS = [
  'title',
  'description',
  'projectId',
  'statusId',
  'parentId',
  'priority',
  'position',
  'dueDate',
  'dueTime',
  'startDate',
  'repeatConfig',
  'repeatFrom',
  'sourceNoteId',
  'completedAt',
  'archivedAt'
] as const

export const PROJECT_SYNCABLE_FIELDS = [
  'name',
  'description',
  'color',
  'icon',
  'position',
  'isInbox',
  'archivedAt',
  'modifiedAt'
] as const

export function initAllFieldClocks(docClock: VectorClock, fields: readonly string[]): FieldClocks {
  const fc: FieldClocks = {}
  for (const f of fields) fc[f] = { ...docClock }
  return fc
}

function tickSum(clock: VectorClock): number {
  let sum = 0
  for (const v of Object.values(clock)) sum += v
  return sum
}

export interface MergeResult<T> {
  merged: Partial<T>
  mergedFieldClocks: FieldClocks
  hadConflicts: boolean
  conflictedFields: string[]
}

export function mergeFields<T>(
  localData: T,
  remoteData: T,
  localFieldClocks: FieldClocks,
  remoteFieldClocks: FieldClocks,
  syncableFields: readonly string[]
): MergeResult<T> {
  const merged: Record<string, unknown> = {}
  const mergedFieldClocks: FieldClocks = {}
  const conflictedFields: string[] = []
  let hadConflicts = false

  for (const field of syncableFields) {
    const localFC = localFieldClocks[field] ?? {}
    const remoteFC = remoteFieldClocks[field] ?? {}
    const localSum = tickSum(localFC)
    const remoteSum = tickSum(remoteFC)

    const localVal = (localData as Record<string, unknown>)[field]
    const remoteVal = (remoteData as Record<string, unknown>)[field]
    const isConcurrent = localSum > 0 && remoteSum > 0 && localSum === remoteSum
    const valsDiffer = JSON.stringify(localVal) !== JSON.stringify(remoteVal)

    let winner: 'local' | 'remote'
    if (remoteSum > localSum) {
      merged[field] = remoteVal
      winner = 'remote'
    } else if (localSum > remoteSum) {
      merged[field] = localVal
      winner = 'local'
    } else {
      const localHasOffline = '_offline' in localFC && !('_offline' in remoteFC)
      if (localHasOffline && valsDiffer) {
        merged[field] = localVal
        winner = 'local'
      } else {
        merged[field] = remoteVal
        winner = 'remote'
      }
      if (isConcurrent && valsDiffer) {
        hadConflicts = true
        conflictedFields.push(field)
      }
    }

    if (valsDiffer) {
      log.debug('Field merge decision', {
        field,
        winner,
        localSum,
        remoteSum,
        localFC,
        remoteFC
      })
    }

    mergedFieldClocks[field] = mergeClock(localFC, remoteFC)
  }

  return {
    merged: merged as Partial<T>,
    mergedFieldClocks,
    hadConflicts,
    conflictedFields
  }
}

export function mergeTaskFields(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  localFC: FieldClocks,
  remoteFC: FieldClocks
): MergeResult<Record<string, unknown>> {
  return mergeFields(local, remote, localFC, remoteFC, TASK_SYNCABLE_FIELDS)
}

export function mergeProjectFields(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  localFC: FieldClocks,
  remoteFC: FieldClocks
): MergeResult<Record<string, unknown>> {
  return mergeFields(local, remote, localFC, remoteFC, PROJECT_SYNCABLE_FIELDS)
}
