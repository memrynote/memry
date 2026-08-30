import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DataDb } from '../database/types'

const mocks = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  syncSettingsFieldUpdate: vi.fn()
}))

vi.mock('../database/queries/settings', () => ({
  getSetting: (_db: unknown, key: string) => mocks.rows.get(key) ?? null,
  setSetting: (_db: unknown, key: string, value: string) => {
    mocks.rows.set(key, value)
  }
}))

vi.mock('../sync/local-mutations', () => ({
  syncSettingsFieldUpdate: mocks.syncSettingsFieldUpdate
}))

import {
  SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY,
  readSidebarNavCollapsed,
  writeSidebarNavCollapsed
} from './sidebar-nav-store'

const db = {} as DataDb

const stored = (): string | undefined => mocks.rows.get(SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY)

describe('sidebar-nav-store', () => {
  beforeEach(() => {
    mocks.rows.clear()
    vi.clearAllMocks()
  })

  it('reads an absent row as expanded', () => {
    expect(readSidebarNavCollapsed(db)).toBe(false)
  })

  it('reads back both stored booleans', () => {
    mocks.rows.set(SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY, 'true')
    expect(readSidebarNavCollapsed(db)).toBe(true)

    mocks.rows.set(SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY, 'false')
    expect(readSidebarNavCollapsed(db)).toBe(false)
  })

  it('reads a malformed row as expanded instead of throwing', () => {
    mocks.rows.set(SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY, '{not json')

    expect(() => readSidebarNavCollapsed(db)).not.toThrow()
    expect(readSidebarNavCollapsed(db)).toBe(false)
  })

  it('reads a non-boolean row as expanded', () => {
    for (const raw of ['"yes"', '{}', '1', 'null']) {
      mocks.rows.set(SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY, raw)
      expect(readSidebarNavCollapsed(db)).toBe(false)
    }
  })

  it('persists a collapse and enqueues it for sync', () => {
    expect(writeSidebarNavCollapsed(db, true)).toBe(true)

    expect(stored()).toBe('true')
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenCalledWith(
      SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY,
      true
    )
  })

  // The other device only learns the nav is open again from a `false` on the
  // wire, so this write has to travel exactly as far as the `true` one does.
  it('persists an expand and enqueues it for sync', () => {
    mocks.rows.set(SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY, 'true')

    expect(writeSidebarNavCollapsed(db, false)).toBe(false)

    expect(stored()).toBe('false')
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenCalledWith(
      SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY,
      false
    )
  })
})
