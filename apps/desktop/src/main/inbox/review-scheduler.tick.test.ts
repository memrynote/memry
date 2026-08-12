import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const show = vi.fn()
const send = vi.fn()
vi.mock('electron', () => ({
  Notification: Object.assign(
    vi.fn().mockImplementation(function () {
      return { on: vi.fn(), show }
    }),
    { isSupported: () => true }
  ),
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    ]
  },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('../vault', () => ({ getStatus: () => ({ isOpen: true }) }))
vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({
    getFixedT: () => (k: string, o?: { count?: number }) => `${k}:${o?.count ?? ''}`
  })
}))

let enabled = true
let time = '18:00'
let count = 3
vi.mock('../ipc/settings-handlers', () => ({
  getInboxReviewSettings: () => ({ reviewReminderEnabled: enabled, reviewReminderTime: time })
}))
vi.mock('./stats', () => ({ countReviewableInboxItems: () => count }))

const store = new Map<string, string>()
vi.mock('../database', () => ({ getDatabase: () => ({}) }))
vi.mock('../database/queries/settings', () => ({
  getSetting: (_db: unknown, k: string) => store.get(k) ?? null,
  setSetting: (_db: unknown, k: string, v: string) => void store.set(k, v)
}))

import {
  runReviewTick,
  getLastReviewFireForTest,
  startInboxReviewScheduler,
  stopInboxReviewScheduler,
  isReviewSchedulerRunning
} from './review-scheduler'
import { getMinuteTickIds, isMinuteTickRunning } from '../lib/minute-tick'

const at = (h: number, mi: number) => new Date(2026, 6, 17, h, mi, 0, 0)

describe('runReviewTick', () => {
  beforeEach(() => {
    show.mockClear()
    send.mockClear()
    store.clear()
    enabled = true
    time = '18:00'
    count = 3
  })

  it('notifies once and persists the local date', () => {
    const r = runReviewTick(at(18, 0))
    expect(r).toEqual({ notified: true, count: 3 })
    expect(show).toHaveBeenCalledTimes(1)
    expect(store.get('inbox.reviewLastNotifiedDate')).toBe('2026-07-17')
    expect(getLastReviewFireForTest()).toEqual({ date: '2026-07-17', count: 3 })
  })

  it('emits the REVIEW_DUE event with the count', () => {
    runReviewTick(at(18, 0))
    expect(send).toHaveBeenCalledWith('inbox:review-due', { count: 3 })
  })

  it('is idempotent on a second tick the same day', () => {
    runReviewTick(at(18, 0))
    show.mockClear()
    const r = runReviewTick(at(18, 30))
    expect(r.notified).toBe(false)
    expect(show).not.toHaveBeenCalled()
  })

  it('does not notify when disabled', () => {
    enabled = false
    expect(runReviewTick(at(18, 0)).notified).toBe(false)
  })

  it('does not notify with an empty inbox', () => {
    count = 0
    expect(runReviewTick(at(18, 0)).notified).toBe(false)
  })
})

describe('startInboxReviewScheduler', () => {
  afterEach(() => {
    stopInboxReviewScheduler()
  })

  it('subscribes to the shared minute tick instead of owning a timer', () => {
    enabled = false // keep the startup catch-up quiet
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    startInboxReviewScheduler()

    expect(getMinuteTickIds()).toEqual(['inbox-review'])
    expect(isReviewSchedulerRunning()).toBe(true)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)

    stopInboxReviewScheduler()

    expect(getMinuteTickIds()).toEqual([])
    expect(isMinuteTickRunning()).toBe(false)
    setIntervalSpy.mockRestore()
  })
})
