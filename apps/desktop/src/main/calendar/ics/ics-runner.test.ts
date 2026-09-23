import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { database, refreshed } = vi.hoisted(() => ({
  database: { initialized: false, db: { name: 'vault-db' } },
  refreshed: [] as unknown[]
}))

vi.mock('../../database', () => ({
  isDatabaseInitialized: () => database.initialized,
  requireDatabase: () => database.db
}))

vi.mock('./ics-subscriptions', () => ({
  refreshDueIcsCalendars: async (db: unknown) => {
    refreshed.push(db)
  }
}))

import { startIcsCalendarRunner, stopIcsCalendarRunner } from './ics-runner'

describe('ICS calendar runner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    refreshed.length = 0
    database.initialized = false
  })

  afterEach(() => {
    stopIcsCalendarRunner()
    vi.useRealTimers()
  })

  it('waits for a vault, then refreshes on every tick until stopped', async () => {
    startIcsCalendarRunner()
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshed).toEqual([])

    database.initialized = true
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(refreshed).toEqual([database.db])

    stopIcsCalendarRunner()
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(refreshed).toEqual([database.db])
  })
})
