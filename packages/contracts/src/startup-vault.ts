/**
 * Startup vault
 *
 * The vault a main window opens into, passed from main to the preload on the
 * window's command line (`webPreferences.additionalArguments`). The preload
 * reads it without an IPC round trip, so it never waits behind main's
 * synchronous vault open. The value is fixed when the window is created. After
 * an in-session vault switch it still names the launch vault.
 *
 * @module contracts/startup-vault
 */

const STARTUP_VAULT_ARG_PREFIX = '--memry-startup-vault='

export function startupVaultArgs(vaultPath: string | null): string[] {
  return vaultPath ? [`${STARTUP_VAULT_ARG_PREFIX}${vaultPath}`] : []
}

export function readStartupVaultArg(argv: readonly string[]): string | null {
  const arg = argv.find((value) => value.startsWith(STARTUP_VAULT_ARG_PREFIX))
  return arg?.slice(STARTUP_VAULT_ARG_PREFIX.length) || null
}
