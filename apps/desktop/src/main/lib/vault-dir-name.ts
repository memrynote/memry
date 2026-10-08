import { createHash } from 'node:crypto'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Filesystem-safe directory name for a vault uuid.
 *
 * The uuid is minted by `randomUUID()` locally, but a linked device adopts the
 * *server's* value, so this must not assume the shape. A canonical uuid is used
 * verbatim (readable in logs and support sessions); anything else is hashed, so
 * a separator, a path traversal or a case-only difference can never resolve to
 * another vault's directory. Lower-cased first because macOS and Windows
 * filesystems are case-insensitive: two casings of one uuid must be one folder.
 */
export function vaultDirName(vaultUuid: string): string {
  const normalized = vaultUuid.trim().toLowerCase()
  if (UUID_PATTERN.test(normalized)) return normalized
  return createHash('sha256').update(vaultUuid).digest('hex').slice(0, 32)
}
