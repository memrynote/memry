/**
 * What kind of thing an editor asset reference points at (#2097).
 *
 * The guest asks for one string over `asset-req` and cannot tell the two apart:
 * a note body carries vault-relative attachment paths AND remote URLs (a link
 * mention's favicon, a bookmark's card image). The host is the only side that
 * can fetch either, so it classifies here and dispatches.
 */

export type AssetRef = { kind: 'vault'; ref: string } | { kind: 'remote'; url: string }

export function classifyAssetRef(ref: string): AssetRef {
  try {
    // Only `https:` is remote. Plain `http:` is cleartext and must not be
    // fetched, and a malformed `https://` is not a URL we can honour; both fall
    // through to the vault path, where they resolve as `missing` and the guest
    // stops asking. That is the right visible outcome for either.
    if (new URL(ref).protocol === 'https:') return { kind: 'remote', url: ref }
  } catch {
    // Not a URL at all, which is the ordinary case: a relative attachment path.
  }
  return { kind: 'vault', ref }
}
