import type { ClientPolicy } from '@memry/contracts/sync-api'

import { compareVersions, type ClientPlatform } from '../lib/client-identity'

export interface ClientPolicyRow {
  platform: string
  min_write_version: string | null
  writes_enabled: number
  updated_at: number
}

export type WriteAccess =
  | { allowed: true }
  | { allowed: false; reason: 'kill_switch' }
  | { allowed: false; reason: 'below_floor'; minVersion: string }

export const getClientPolicy = async (
  db: D1Database,
  platform: ClientPlatform
): Promise<ClientPolicyRow | null> =>
  db
    .prepare(
      'SELECT platform, min_write_version, writes_enabled, updated_at FROM client_policies WHERE platform = ?'
    )
    .bind(platform)
    .first<ClientPolicyRow>()

/**
 * The decision table from contracts/sync-protocol-additions.md §2. Every
 * uncertain case resolves to ALLOW: no row, NULL floor, and an unparseable
 * floor all mean "no floor configured". A policy table that cannot be
 * interpreted must degrade to today's behaviour, not to a lockout.
 */
export const evaluateWriteAccess = (
  policy: ClientPolicyRow | null,
  clientVersion: string
): WriteAccess => {
  if (!policy) return { allowed: true }

  // Kill switch is checked first: when writes are off for a platform, the
  // version floor is irrelevant and reporting CLIENT_UPGRADE_REQUIRED would
  // send users chasing an update that cannot help them.
  if (policy.writes_enabled === 0) return { allowed: false, reason: 'kill_switch' }

  const floor = policy.min_write_version
  if (floor === null || floor.trim().length === 0) return { allowed: true }

  const comparison = compareVersions(clientVersion, floor)
  if (comparison === null) return { allowed: true }
  if (comparison < 0) return { allowed: false, reason: 'below_floor', minVersion: floor }

  return { allowed: true }
}

/** The subset a client is told about itself (contract §2, last bullet). */
export const toPolicySnapshot = (
  platform: ClientPlatform,
  policy: ClientPolicyRow | null
): ClientPolicy => ({
  platform,
  writesEnabled: policy ? policy.writes_enabled !== 0 : true,
  ...(policy?.min_write_version ? { minWriteVersion: policy.min_write_version } : {})
})

/**
 * Whether snapshot claims are honoured (#2299, protocol 07 §7.7.1). A claimed
 * row answers a pre-#2299 desktop's unclaimed push with a 409 it retries until
 * it upgrades, so claims stay dormant until `required`
 * (`CRDT_CLAIM_MIN_DESKTOP_VERSION`) is set and the desktop write floor has
 * reached it. Until then a claim is dropped and the push runs under the
 * pre-#2299 rules, so no claimed row exists and no legacy client sees the 409.
 */
export const snapshotClaimsEnabled = async (
  db: D1Database,
  required: string | undefined
): Promise<boolean> => {
  if (!required) return false
  const floor = (await getClientPolicy(db, 'desktop'))?.min_write_version
  if (!floor) return false
  const comparison = compareVersions(floor, required)
  return comparison !== null && comparison >= 0
}
