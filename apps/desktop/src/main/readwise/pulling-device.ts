import type { DataDb } from '../database/types'
import { getMainI18n } from '../lib/main-i18n'
import { pullAuthority } from './pull-gate'

/**
 * The book commands (D16) need the token, which lives on the pulling device
 * only, so each asks this first. Who pulls is decided in `pull-gate.ts` (D8).
 */
export function thisDevicePulls(db: DataDb): boolean {
  return pullAuthority(db).state !== 'elsewhere'
}

/** The pulling device's name when another device pulls and the claim carries one, else null. */
export function pullingDeviceName(db: DataDb): string | null {
  const authority = pullAuthority(db)
  return authority.state === 'elsewhere' ? authority.deviceName : null
}

export function assertThisDevicePulls(db: DataDb): void {
  if (!thisDevicePulls(db)) {
    throw new Error(getMainI18n().t('errors:importer.readwiseSyncsElsewhere'))
  }
}
