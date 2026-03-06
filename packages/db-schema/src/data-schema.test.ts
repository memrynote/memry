import { describe, expect, it } from 'vitest'

import * as dataSchema from './data-schema'

describe('data-schema exports', () => {
  it('re-exports sync foundation tables', () => {
    expect(dataSchema.syncDevices).toBeDefined()
    expect(dataSchema.syncQueue).toBeDefined()
    expect(dataSchema.syncState).toBeDefined()
    expect(dataSchema.syncHistory).toBeDefined()

    expect(dataSchema.syncDevices[Symbol.for('drizzle:Name')]).toBe('sync_devices')
    expect(dataSchema.syncQueue[Symbol.for('drizzle:Name')]).toBe('sync_queue')
    expect(dataSchema.syncState[Symbol.for('drizzle:Name')]).toBe('sync_state')
    expect(dataSchema.syncHistory[Symbol.for('drizzle:Name')]).toBe('sync_history')
  })
})
