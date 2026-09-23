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
  SIDEBAR_NOTES_FIRST_SETTINGS_KEY,
  SIDEBAR_SHOW_FILES_SETTINGS_KEY,
  readSidebarNotesFirst,
  readSidebarShowFiles,
  writeSidebarNotesFirst,
  writeSidebarShowFiles
} from './sidebar-tree-view-store'

const db = {} as DataDb

describe('sidebar-tree-view-store', () => {
  beforeEach(() => {
    mocks.rows.clear()
    vi.clearAllMocks()
  })

  // Absent rows are every install from before the toggles: the tree they get
  // has to be the one they already had.
  it('reads absent rows as folders first and files shown', () => {
    expect(readSidebarNotesFirst(db)).toBe(false)
    expect(readSidebarShowFiles(db)).toBe(true)
  })

  it('reads back both stored booleans for each flag', () => {
    mocks.rows.set(SIDEBAR_NOTES_FIRST_SETTINGS_KEY, 'true')
    mocks.rows.set(SIDEBAR_SHOW_FILES_SETTINGS_KEY, 'false')
    expect(readSidebarNotesFirst(db)).toBe(true)
    expect(readSidebarShowFiles(db)).toBe(false)

    mocks.rows.set(SIDEBAR_NOTES_FIRST_SETTINGS_KEY, 'false')
    mocks.rows.set(SIDEBAR_SHOW_FILES_SETTINGS_KEY, 'true')
    expect(readSidebarNotesFirst(db)).toBe(false)
    expect(readSidebarShowFiles(db)).toBe(true)
  })

  it('reads malformed or non-boolean rows as the default instead of throwing', () => {
    for (const raw of ['{not json', '"yes"', '{}', '1', 'null']) {
      mocks.rows.set(SIDEBAR_NOTES_FIRST_SETTINGS_KEY, raw)
      mocks.rows.set(SIDEBAR_SHOW_FILES_SETTINGS_KEY, raw)
      expect(readSidebarNotesFirst(db)).toBe(false)
      expect(readSidebarShowFiles(db)).toBe(true)
    }
  })

  it('persists notes-first and enqueues it for sync, false included', () => {
    expect(writeSidebarNotesFirst(db, true)).toBe(true)
    expect(mocks.rows.get(SIDEBAR_NOTES_FIRST_SETTINGS_KEY)).toBe('true')
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenLastCalledWith(
      SIDEBAR_NOTES_FIRST_SETTINGS_KEY,
      true
    )

    expect(writeSidebarNotesFirst(db, false)).toBe(false)
    expect(mocks.rows.get(SIDEBAR_NOTES_FIRST_SETTINGS_KEY)).toBe('false')
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenLastCalledWith(
      SIDEBAR_NOTES_FIRST_SETTINGS_KEY,
      false
    )
  })

  // The other device only learns files are hidden from a `false` on the wire.
  it('persists show-files and enqueues it for sync, false included', () => {
    expect(writeSidebarShowFiles(db, false)).toBe(false)
    expect(mocks.rows.get(SIDEBAR_SHOW_FILES_SETTINGS_KEY)).toBe('false')
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenLastCalledWith(
      SIDEBAR_SHOW_FILES_SETTINGS_KEY,
      false
    )

    expect(writeSidebarShowFiles(db, true)).toBe(true)
    expect(mocks.rows.get(SIDEBAR_SHOW_FILES_SETTINGS_KEY)).toBe('true')
    expect(mocks.syncSettingsFieldUpdate).toHaveBeenLastCalledWith(
      SIDEBAR_SHOW_FILES_SETTINGS_KEY,
      true
    )
  })
})
