import type { VectorClock, SyncItem } from './types.js'
import type { SyncItemType } from '@memry/contracts/sync-api'

interface Operation {
  deviceId: string
  itemId: string
  type: SyncItemType
  fields: Record<string, unknown>
  clock: VectorClock
  operation: 'create' | 'update' | 'delete'
  timestamp: number
}

/**
 * Clean-room reference implementation of field-level merge.
 * Records all operations in causal order and resolves the expected state
 * using LWW-per-field (tasks) or LWW-per-document (settings).
 *
 * The oracle NEVER uses the production sync code — it's an independent
 * reimplementation that serves as the correctness baseline.
 */
export class OracleModel {
  private operations: Operation[] = []
  private opCounter = 0

  record(op: {
    deviceId: string
    itemId: string
    type: SyncItemType
    fields: Record<string, unknown>
    clock: VectorClock
    operation: 'create' | 'update' | 'delete'
  }): void {
    this.operations.push({
      ...op,
      timestamp: this.opCounter++
    })
  }

  resolve(): Map<string, SyncItem> {
    const items = new Map<string, SyncItem>()

    const sorted = [...this.operations].sort((a, b) => a.timestamp - b.timestamp)

    for (const op of sorted) {
      if (op.operation === 'delete') {
        items.delete(op.itemId)
        continue
      }

      const existing = items.get(op.itemId)

      if (!existing) {
        items.set(op.itemId, {
          id: op.itemId,
          type: op.type,
          content: { ...op.fields },
          clock: { ...op.clock },
          operation: op.operation
        })
        continue
      }

      if (op.type === 'settings') {
        const winner = this.resolveDocumentLWW(existing.clock, op.clock)
        if (winner === 'remote') {
          items.set(op.itemId, {
            ...existing,
            content: { ...op.fields },
            clock: this.mergeClock(existing.clock, op.clock),
            operation: 'update'
          })
        } else {
          items.set(op.itemId, {
            ...existing,
            clock: this.mergeClock(existing.clock, op.clock)
          })
        }
        continue
      }

      const mergedContent = this.mergeFieldLWW(
        existing.content,
        op.fields,
        existing.clock,
        op.clock
      )
      items.set(op.itemId, {
        ...existing,
        content: mergedContent,
        clock: this.mergeClock(existing.clock, op.clock),
        operation: 'update'
      })
    }

    return items
  }

  compare(actual: Map<string, SyncItem>): Mismatch[] {
    const expected = this.resolve()
    const mismatches: Mismatch[] = []

    for (const [id, expectedItem] of expected) {
      const actualItem = actual.get(id)
      if (!actualItem) {
        mismatches.push({ itemId: id, type: 'missing', expected: expectedItem })
        continue
      }
      const fieldDiffs = this.diffContent(expectedItem.content, actualItem.content)
      if (fieldDiffs.length > 0) {
        mismatches.push({
          itemId: id,
          type: 'content_mismatch',
          expected: expectedItem,
          actual: actualItem,
          fieldDiffs
        })
      }
    }

    for (const [id, actualItem] of actual) {
      if (!expected.has(id)) {
        mismatches.push({ itemId: id, type: 'unexpected', actual: actualItem })
      }
    }

    return mismatches
  }

  private resolveDocumentLWW(
    localClock: VectorClock,
    remoteClock: VectorClock
  ): 'local' | 'remote' {
    const localSum = this.tickSum(localClock)
    const remoteSum = this.tickSum(remoteClock)
    return remoteSum >= localSum ? 'remote' : 'local'
  }

  private mergeFieldLWW(
    localFields: Record<string, unknown>,
    remoteFields: Record<string, unknown>,
    localClock: VectorClock,
    remoteClock: VectorClock
  ): Record<string, unknown> {
    const merged = { ...localFields }

    for (const [field, remoteValue] of Object.entries(remoteFields)) {
      const localValue = localFields[field]
      if (localValue === undefined || this.tickSum(remoteClock) >= this.tickSum(localClock)) {
        merged[field] = remoteValue
      }
    }

    return merged
  }

  private tickSum(clock: VectorClock): number {
    return Object.values(clock).reduce((sum, tick) => sum + tick, 0)
  }

  private mergeClock(a: VectorClock, b: VectorClock): VectorClock {
    const merged = { ...a }
    for (const [key, tick] of Object.entries(b)) {
      merged[key] = Math.max(merged[key] ?? 0, tick)
    }
    return merged
  }

  private diffContent(
    expected: Record<string, unknown>,
    actual: Record<string, unknown>
  ): FieldDiff[] {
    const diffs: FieldDiff[] = []
    const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)])

    for (const key of allKeys) {
      if (key === 'clock') continue
      const e = expected[key]
      const a = actual[key]
      if (JSON.stringify(e) !== JSON.stringify(a)) {
        diffs.push({ field: key, expected: e, actual: a })
      }
    }

    return diffs
  }
}

export interface Mismatch {
  itemId: string
  type: 'missing' | 'unexpected' | 'content_mismatch'
  expected?: SyncItem
  actual?: SyncItem
  fieldDiffs?: FieldDiff[]
}

export interface FieldDiff {
  field: string
  expected: unknown
  actual: unknown
}
