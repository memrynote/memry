import { describe, expect, it } from 'vitest'
import { readStartupVaultArg, startupVaultArgs } from './startup-vault'

describe('startup vault argument', () => {
  it('round-trips a vault path through the window command line', () => {
    const vaultPath = 'C:\\Users\\Kaan\\My Vault=2 ✓'
    const argv = ['/path/to/electron', '--type=renderer', ...startupVaultArgs(vaultPath)]

    expect(readStartupVaultArg(argv)).toBe(vaultPath)
  })

  it('reads null when the window opened without a vault', () => {
    expect(readStartupVaultArg(['/path/to/electron', ...startupVaultArgs(null)])).toBeNull()
  })
})
