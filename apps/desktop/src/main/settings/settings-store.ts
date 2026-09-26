import {
  deleteSetting as removeSettingRow,
  getSetting,
  setSetting as writeSettingRow
} from '@main/database/queries/settings'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'

export { getSetting }

const log = createLogger('SettingsStore')

/**
 * Told about every local settings write, with the stored value before and
 * after (`null` = absent). The sync runtime registers one so the calendar
 * groups that sync (spec 007 D3a) reach settings sync from every writer
 * without each writer knowing about sync. Remote applies write through
 * `database/queries/settings` directly, so they never echo back here.
 */
export type SettingWriteListener = (
  db: DataDb,
  key: string,
  before: string | null,
  after: string | null
) => void

let listener: SettingWriteListener | null = null

export function setSettingWriteListener(next: SettingWriteListener | null): void {
  listener = next
}

function notify(db: DataDb, key: string, before: string | null, after: string | null): void {
  if (!listener || before === after) return
  try {
    listener(db, key, before, after)
  } catch (error) {
    // The local write already landed; a failed sync hand-off must not undo it.
    log.warn('Settings write listener failed', { key, error })
  }
}

export function setSetting(db: DataDb, key: string, value: string): void {
  const before = listener ? getSetting(db, key) : null
  writeSettingRow(db, key, value)
  notify(db, key, before, value)
}

export function deleteSetting(db: DataDb, key: string): void {
  const before = listener ? getSetting(db, key) : null
  removeSettingRow(db, key)
  notify(db, key, before, null)
}
