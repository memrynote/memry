/**
 * Seam 2 — certificate pinning.
 *
 * The mobile implementation is an explicit no-op (`isEnforced()` → false). That
 * is a decision, not a gap: a bad pin cannot be fixed faster than App Store
 * review. Desktop keeps its current behaviour.
 */
export interface CertificatePinningAdapter {
  /** Wire pinning into the transport if the platform supports it. */
  configure(pins: ReadonlyArray<string>): void
  isEnforced(): boolean
}
