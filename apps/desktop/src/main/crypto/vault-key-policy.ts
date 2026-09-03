/**
 * How the vault-key binding resolves a verifier mismatch.
 *
 * A vault folder is portable: users move it between machines with git, iCloud
 * Drive or Dropbox, and notes, journals, tasks and canvases all survive the trip
 * because none of them are bound to key material. The `vault.crypto.verifier.v1`
 * row travels inside `<vault>/.memry/data.db`, but the master key that produced
 * it lives in the machine's keychain and does not — so a moved vault routinely
 * arrives holding another machine's verifier. Treating that as fatal took the
 * whole agent runtime down and told the user their CLIs were "not detected".
 *
 * Resolving it needs to know whether this device's master key is the account's,
 * which only the sync layer can answer. `crypto/` deliberately does not import
 * `sync/`, so the sync layer injects the check here at startup instead. The
 * default answers `unknown`, which keeps the pre-injection behaviour (fail loud,
 * never rebind) — a caller that forgot to wire it can only be conservative.
 */
export type AccountKeyCheck = 'match' | 'mismatch' | 'transition' | 'unknown'

export type AccountKeyChecker = () => Promise<AccountKeyCheck>

const unknownChecker: AccountKeyChecker = async () => 'unknown'

let checker: AccountKeyChecker = unknownChecker

/** Wire the sync layer's account-key check in. Called once during startup. */
export function setAccountKeyChecker(next: AccountKeyChecker): void {
  checker = next
}

/** Test-only: drop back to the conservative default. */
export function resetAccountKeyCheckerForTests(): void {
  checker = unknownChecker
}

export function checkAccountKey(): Promise<AccountKeyCheck> {
  return checker()
}
