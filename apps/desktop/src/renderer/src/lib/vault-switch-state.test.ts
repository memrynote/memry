import { afterEach, describe, expect, it } from 'vitest'
import {
  beginVaultSwitch,
  endVaultSwitch,
  getVaultSwitchState,
  resetVaultSwitchState,
  wasEnteredBySwitch
} from './vault-switch-state'

const work = { path: '/vaults/work', name: 'Work', accentColor: '#2f6fed' }

describe('vault switch state', () => {
  afterEach(() => resetVaultSwitchState())

  it('marks the closed-vault gap as a switch until it settles', () => {
    beginVaultSwitch(work, 'next')
    expect(getVaultSwitchState().pending).toEqual(work)

    endVaultSwitch(true)
    expect(getVaultSwitchState().pending).toBeNull()
  })

  it('remembers the vault a switch arrived in, and nothing on a cold start', () => {
    expect(wasEnteredBySwitch('/vaults/work')).toBe(false)

    beginVaultSwitch(work, 'prev')
    endVaultSwitch(true)

    expect(wasEnteredBySwitch('/vaults/work')).toBe(true)
    expect(wasEnteredBySwitch('/vaults/personal')).toBe(false)
    expect(getVaultSwitchState().arrival).toEqual({ path: '/vaults/work', direction: 'prev' })
  })

  it('forgets the arrival when the switch failed', () => {
    beginVaultSwitch(work, 'next')
    endVaultSwitch(false)

    expect(wasEnteredBySwitch('/vaults/work')).toBe(false)
  })
})
