import {
  OFFLINE_CLOCK_DEVICE_ID,
  type VectorClock,
  type FieldClocks
} from '@memry/contracts/sync-api'
import { merge as mergeClock } from './vector-clock'
import { compare as compareClock } from './vector-clock'

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

function clockTotal(clock: VectorClock): number {
  let total = 0
  for (const value of Object.values(clock)) total += value
  return total
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
    const clockComparison = compareClock(localFC, remoteFC)
    const localTotal = clockTotal(localFC)
    const remoteTotal = clockTotal(remoteFC)

    const localVal = (localData as Record<string, unknown>)[field]
    const remoteVal = (remoteData as Record<string, unknown>)[field]
    const isConcurrent = clockComparison === 'concurrent'
    const valsDiffer = JSON.stringify(localVal) !== JSON.stringify(remoteVal)

    if (remoteTotal > localTotal) {
      merged[field] = remoteVal
    } else if (localTotal > remoteTotal) {
      merged[field] = localVal
    } else {
      const localHasOffline =
        OFFLINE_CLOCK_DEVICE_ID in localFC && !(OFFLINE_CLOCK_DEVICE_ID in remoteFC)
      if (localHasOffline && valsDiffer) {
        merged[field] = localVal
      } else {
        merged[field] = remoteVal
      }
      if (isConcurrent && valsDiffer) {
        hadConflicts = true
        conflictedFields.push(field)
      }
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
