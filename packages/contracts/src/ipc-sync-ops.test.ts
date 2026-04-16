/**
 * IPC Sync Ops Contract Tests
 *
 * Covers the two runtime-validated schemas (history pagination + synced-setting
 * update) and locks the channel name map used by renderer<->main IPC.
 */

import { describe, it, expect } from 'vitest'

import {
  GetHistorySchema,
  SYNC_OP_CHANNELS,
  UpdateSyncedSettingSchema
} from './ipc-sync-ops'

describe('SYNC_OP_CHANNELS', () => {
  it('namespaces every channel under "sync:"', () => {
    for (const value of Object.values(SYNC_OP_CHANNELS)) {
      expect(value.startsWith('sync:')).toBe(true)
    }
  })

  it('has unique channel values', () => {
    const values = Object.values(SYNC_OP_CHANNELS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('includes expected core operations', () => {
    expect(SYNC_OP_CHANNELS.GET_STATUS).toBe('sync:get-status')
    expect(SYNC_OP_CHANNELS.TRIGGER_SYNC).toBe('sync:trigger-sync')
    expect(SYNC_OP_CHANNELS.PAUSE).toBe('sync:pause')
    expect(SYNC_OP_CHANNELS.RESUME).toBe('sync:resume')
    expect(SYNC_OP_CHANNELS.EMERGENCY_WIPE).toBe('sync:emergency-wipe')
  })
})

describe('GetHistorySchema', () => {
  it('accepts empty object (all optional)', () => {
    expect(GetHistorySchema.safeParse({}).success).toBe(true)
  })

  it('accepts valid limit + offset', () => {
    expect(GetHistorySchema.safeParse({ limit: 50, offset: 0 }).success).toBe(true)
  })

  it('accepts limit at boundaries (1 and 1000)', () => {
    expect(GetHistorySchema.safeParse({ limit: 1 }).success).toBe(true)
    expect(GetHistorySchema.safeParse({ limit: 1000 }).success).toBe(true)
  })

  it('rejects limit below 1', () => {
    const result = GetHistorySchema.safeParse({ limit: 0 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('limit')
    }
  })

  it('rejects limit above 1000', () => {
    expect(GetHistorySchema.safeParse({ limit: 1001 }).success).toBe(false)
  })

  it('rejects non-integer limit', () => {
    expect(GetHistorySchema.safeParse({ limit: 50.5 }).success).toBe(false)
  })

  it('rejects negative offset', () => {
    const result = GetHistorySchema.safeParse({ offset: -1 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('offset')
    }
  })

  it('accepts offset 0', () => {
    expect(GetHistorySchema.safeParse({ offset: 0 }).success).toBe(true)
  })
})

describe('UpdateSyncedSettingSchema', () => {
  it('accepts string value', () => {
    expect(
      UpdateSyncedSettingSchema.safeParse({ fieldPath: 'ui.theme', value: 'dark' }).success
    ).toBe(true)
  })

  it('accepts boolean/number/object/null values (z.unknown)', () => {
    const values: unknown[] = [true, 1, { nested: { a: 1 } }, null, []]
    for (const value of values) {
      expect(
        UpdateSyncedSettingSchema.safeParse({ fieldPath: 'x', value }).success
      ).toBe(true)
    }
  })

  it('rejects missing fieldPath', () => {
    const result = UpdateSyncedSettingSchema.safeParse({ value: 'dark' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('fieldPath')
    }
  })

  it('rejects empty fieldPath', () => {
    expect(
      UpdateSyncedSettingSchema.safeParse({ fieldPath: '', value: 'x' }).success
    ).toBe(false)
  })

  it('accepts undefined value (z.unknown optional-semantics)', () => {
    // z.unknown() accepts undefined. Field is present by key.
    const result = UpdateSyncedSettingSchema.safeParse({
      fieldPath: 'x',
      value: undefined
    })
    expect(result.success).toBe(true)
  })
})
