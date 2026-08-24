import { CLIENT_PLATFORMS, type ClientPlatform } from '@memry/contracts/sync-api'

import { createLogger } from './logger'

const logger = createLogger('ClientIdentity')

/** Header carrying the calling client's platform and version (contract §1). */
export const CLIENT_HEADER = 'x-memry-client'

export type { ClientPlatform }

export interface ClientIdentity {
  platform: ClientPlatform
  /** `major.minor.patch`, without the build suffix. */
  version: string
  /** The `+<build>` suffix when present. Recorded, never compared. */
  build?: string
}

// `<platform>/<semver>[+<build>]` -- e.g. `ios/1.0.0+42`. Pre-release
// identifiers are deliberately NOT accepted: the floor comparison below is a
// numeric triple compare, and silently accepting `1.0.0-beta.1` would make it
// sort as plain `1.0.0` -- a beta would satisfy a floor its release does not.
// Such a header is malformed, which means "treated as absent", which means
// full legacy access rather than a lockout.
const CLIENT_HEADER_PATTERN = /^([a-z]+)\/(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.-]+))?$/

const isClientPlatform = (value: string): value is ClientPlatform =>
  (CLIENT_PLATFORMS as readonly string[]).includes(value)

/**
 * Parse the client header. Returns `null` for absent OR malformed values --
 * the two are the same case downstream by design (contract §1: "malformed
 * header ⇒ treated as absent (log, don't reject)"). A parser bug must never be
 * able to lock a paying user out of their own vault.
 */
export const parseClientIdentity = (raw: string | undefined | null): ClientIdentity | null => {
  if (raw === undefined || raw === null) return null

  const value = raw.trim()
  if (value.length === 0) return null

  const match = CLIENT_HEADER_PATTERN.exec(value)
  if (!match) {
    logger.warn('Malformed client header ignored', { code: 'CLIENT_HEADER_MALFORMED' })
    return null
  }

  const [, platform, major, minor, patch, build] = match
  if (!isClientPlatform(platform)) {
    logger.warn('Unknown client platform ignored', { code: 'CLIENT_PLATFORM_UNKNOWN', platform })
    return null
  }

  return {
    platform,
    version: `${major}.${minor}.${patch}`,
    ...(build ? { build } : {})
  }
}

/**
 * `-1 | 0 | 1` for `a` against `b`, both `major.minor.patch`. Returns `null`
 * when either side is not a plain triple -- callers treat that as "no usable
 * floor" and allow, rather than guessing an ordering.
 */
export const compareVersions = (a: string, b: string): -1 | 0 | 1 | null => {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }

  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null

  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1
    if (left[i] < right[i]) return -1
  }
  return 0
}
