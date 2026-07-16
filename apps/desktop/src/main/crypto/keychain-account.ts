import type { KeychainEntry } from '@memry/contracts/crypto'

/**
 * Plain `pnpm dev` sets `MEMRY_DEVICE` to `dev-<checkout-path-hash>` so each git
 * worktree gets its own isolated userData dir (see `resolveDeviceId` in
 * `main/index.ts`). The OS keychain, though, is machine-global, and the vault
 * folder that stores the key verifier (`<vault>/.memry/data.db`) is shared across
 * worktrees. Scoping the master-key account by the per-worktree hash therefore
 * strands the key: opening the same dev vault from a second worktree looks under a
 * different keychain account and fails with "verifier exists but master key is
 * missing", which makes Agent Chat report its providers unavailable.
 *
 * Collapse the per-worktree dev hash to a stable `dev` suffix so every plain-dev
 * worktree shares one master key. Production (`MEMRY_DEVICE` unset -> bare account)
 * and explicit devices (`A`/`B`/`C`, `e2e-*`) are intentionally left untouched.
 */
const DEV_WORKTREE_DEVICE = /^dev-[0-9a-f]{8}$/

export function normalizeDeviceSuffix(deviceSuffix: string | undefined): string | undefined {
  if (deviceSuffix && DEV_WORKTREE_DEVICE.test(deviceSuffix)) {
    return 'dev'
  }
  return deviceSuffix || undefined
}

export function resolveKeychainAccount(
  entry: KeychainEntry,
  deviceSuffix: string | undefined
): string {
  const normalized = normalizeDeviceSuffix(deviceSuffix)
  return normalized ? `${entry.account}-${normalized}` : entry.account
}
