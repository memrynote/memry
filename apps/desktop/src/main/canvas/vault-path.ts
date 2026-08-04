/**
 * The open vault's path, for canvas code that must reach the `.excalidraw`
 * files. Its own module (rather than a helper on the store) so the sync handler
 * can resolve the vault without importing the IPC layer or the crypto stack —
 * canvas persistence has no key dependency and must keep it that way.
 *
 * @module canvas/vault-path
 */

import { getStatus as getVaultStatus } from '../vault/index'

/** The open vault path, or null when no vault is open (closed-vault safe). */
export function getCanvasVaultPath(): string | null {
  return getVaultStatus().path ?? null
}
