export const DEFAULT_SYNC_CERT_HOSTNAME = 'sync.memrynote.com'

export const PINNED_CERTIFICATE_HASHES_BY_HOST: Record<string, readonly string[]> = {
  [DEFAULT_SYNC_CERT_HOSTNAME]: [
    'sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64',
    'sha256/PLACEHOLDER_BACKUP_CERT_HASH_BASE64'
  ],
  'sync-staging.memrynote.com': ['sha256/LUkXdP3NZ4aBKbFriRvHtAP2pzTAO9sMqzOnl24KZV4=']
}

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

export function getConfiguredSyncCertHostname(syncServerUrl = process.env.SYNC_SERVER_URL): string {
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
  syncServerUrl = process.env.SYNC_SERVER_URL
): readonly string[] {
  return getPinnedCertificateHashesForHostname(getConfiguredSyncCertHostname(syncServerUrl))
}
