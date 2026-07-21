import { createHash } from 'node:crypto'

/** sha256 hex of the plaintext image bytes — the vault-scoped dedup key. Collision-safe content address. */
export function hashAssetContent(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** File extension for a mime type (content-addressed filenames). */
export function extForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/svg+xml':
      return 'svg'
    default:
      return 'bin'
  }
}

/** Content-addressed on-disk filename: `<contentHash>.<ext>`. */
export function assetFilename(contentHash: string, mimeType: string): string {
  return `${contentHash}.${extForMime(mimeType)}`
}
