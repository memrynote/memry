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
  'modifiedAt',
  'homeNoteId'
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

/**
 * One field where both sides edited concurrently and the values differed.
 *
 * `mergedClock` is the union of the two field clocks. Clock merge is
 * commutative, so both devices compute the same value for the same pair of
 * edits — which is what lets the activity log mint a matching id on each side
 * and collapse the two mirror-image rows into one.
 */
export interface FieldConflict {
  field: string
  localValue: unknown
  remoteValue: unknown
  mergedValue: unknown
  mergedClock: VectorClock
}

export interface MergeResult<T> {
  merged: Partial<T>
  mergedFieldClocks: FieldClocks
  hadConflicts: boolean
  conflictedFields: string[]
  conflicts: FieldConflict[]
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
  const conflicts: FieldConflict[] = []
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
        conflicts.push({
          field,
          localValue: localVal,
          remoteValue: remoteVal,
          mergedValue: merged[field],
          mergedClock: mergeClock(localFC, remoteFC)
        })
      }
    }

    mergedFieldClocks[field] = mergeClock(localFC, remoteFC)
  }

  return {
    merged: merged as Partial<T>,
    mergedFieldClocks,
    hadConflicts,
    conflictedFields,
    conflicts
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
