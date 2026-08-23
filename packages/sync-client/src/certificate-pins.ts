import { readEnv } from './env'

export const DEFAULT_SYNC_CERT_HOSTNAME = 'sync.memrynote.com'

export const PINNED_CERTIFICATE_HASHES_BY_HOST: Record<string, readonly string[]> = {
  [DEFAULT_SYNC_CERT_HOSTNAME]: [
    'sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64',
    'sha256/PLACEHOLDER_BACKUP_CERT_HASH_BASE64'
  ],
  'sync-staging.memrynote.com': ['sha256/LUkXdP3NZ4aBKbFriRvHtAP2pzTAO9sMqzOnl24KZV4=']
}

const SPKI_PIN_PATTERN = /^sha256\/[A-Za-z0-9+/]{43}=$/

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, '')
}

export function hasPlaceholderHashes(
  pins: readonly string[] = getConfiguredPinnedCertificateHashes()
): boolean {
  return pins.some((pin) => /PLACEHOLDER/i.test(pin))
}

export function getPinnedCertificateHashesForHostname(hostname: string): readonly string[] {
  return PINNED_CERTIFICATE_HASHES_BY_HOST[normalizeHostname(hostname)] ?? []
}

export function getConfiguredSyncCertHostname(syncServerUrl = readEnv('SYNC_SERVER_URL')): string {
  if (!syncServerUrl) {
    return DEFAULT_SYNC_CERT_HOSTNAME
  }

  try {
    const parsed = new URL(syncServerUrl)
    return normalizeHostname(parsed.hostname)
  } catch {
    return DEFAULT_SYNC_CERT_HOSTNAME
  }
}

export function getConfiguredPinnedCertificateHashes(
  syncServerUrl = readEnv('SYNC_SERVER_URL')
): readonly string[] {
  return getPinnedCertificateHashesForHostname(getConfiguredSyncCertHostname(syncServerUrl))
}

export interface CertificatePinConfigResult {
  level: 'ok' | 'warn' | 'error'
  message: string
}

/**
 * Build-time audit of a host's pin entry. Placeholder pins are a supported
 * state — the runtime falls back to standard TLS for them (see
 * `createPinnedAgent`) — so they warn rather than fail. Only genuinely broken
 * config fails: a host with no entry, or a pin that is not an SPKI hash and so
 * could never match a real certificate. `strict` is for release builds of a
 * host whose pinning has actually been activated.
 */
export function checkCertificatePinConfig({
  hostname,
  pins,
  strict = false
}: {
  hostname: string
  pins: readonly string[]
  strict?: boolean
}): CertificatePinConfigResult {
  if (pins.length === 0) {
    return {
      level: 'error',
      message: `No certificate pins configured for sync host ${hostname}. Add an entry to certificate-pins.ts.`
    }
  }

  const malformed = pins.filter((pin) => !SPKI_PIN_PATTERN.test(pin) && !/PLACEHOLDER/i.test(pin))
  if (malformed.length > 0) {
    return {
      level: 'error',
      message: `Malformed certificate pin(s) for sync host ${hostname}: ${malformed.join(', ')}. Expected sha256/<base64 SPKI hash>.`
    }
  }

  if (hasPlaceholderHashes(pins)) {
    const remedy = `Run 'pnpm cert:extract -- ${hostname}' and update the matching host entry in certificate-pins.ts.`
    return strict
      ? {
          level: 'error',
          message: `Certificate pinning is required for sync host ${hostname} (MEMRY_CERT_PINS_STRICT=1) but the host still has placeholder pins. ${remedy}`
        }
      : {
          level: 'warn',
          message: `Certificate pinning is not activated for sync host ${hostname} — this build uses standard TLS. ${remedy}`
        }
  }

  return { level: 'ok', message: `Certificate pins OK for ${hostname} (${pins.length} pinned)` }
}
