/**
 * Pure size-gate for imported assets.
 */

/** Default maximum asset size: 10 MiB. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024

/**
 * Returns true when the byte length exceeds the allowed maximum.
 *
 * @param byteLength - Size of the asset in bytes.
 * @param maxBytes   - Override the default 10 MiB cap.
 */
export function exceedsMaxSize(byteLength: number, maxBytes = MAX_ASSET_BYTES): boolean {
  return byteLength > maxBytes
}
