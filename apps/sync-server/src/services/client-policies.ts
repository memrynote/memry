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
