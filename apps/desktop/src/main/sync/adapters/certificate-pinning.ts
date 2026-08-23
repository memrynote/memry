import type { CertificatePinningAdapter } from '@memry/sync-client/adapters'

/**
 * Desktop implementation of seam 2.
 *
 * Transport-level enforcement stays where it lives today — the shared pinned
 * https agent in `../certificate-pinning.ts` — until the engine drives
 * requests through the seam. This adapter records the configured pin list and
 * answers `isEnforced` from it plus the injected disabled-check (electron's
 * `app.isPackaged` gate, supplied by `wiring.ts`), so the engine's view of
 * pinning matches what the transport actually does.
 */
export class DesktopCertificatePinning implements CertificatePinningAdapter {
  private pins: ReadonlyArray<string> = []

  constructor(private readonly pinningDisabled: () => boolean) {}

  configure(pins: ReadonlyArray<string>): void {
    this.pins = pins
  }

  isEnforced(): boolean {
    return this.pins.length > 0 && !this.pinningDisabled()
  }
}
