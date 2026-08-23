import type { CertificatePinningAdapter } from '@memry/sync-client/adapters'

/**
 * Seam 2 on mobile: an EXPLICIT no-op — a decision, not a gap (tasks.md T037,
 * contracts/platform-adapters.md §2). A bad pin cannot be shipped-around faster
 * than App Store review, so mobile relies on the OS trust store; desktop keeps
 * its own behaviour unchanged.
 */
export function createMobileCertificatePinning(): CertificatePinningAdapter {
  return {
    configure() {
      // Intentionally ignores the pins. isEnforced() tells the engine so.
    },
    isEnforced() {
      return false
    }
  }
}
