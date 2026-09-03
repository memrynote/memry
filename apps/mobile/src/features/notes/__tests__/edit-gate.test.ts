import { describe, expect, it } from 'vitest'
import { editGate } from '../edit-gate'

describe('editGate', () => {
  it('is editing on a writable vault and locked on a read-only one', () => {
    expect(editGate({ vaultReadOnly: false })).toBe('editing')
    expect(editGate({ vaultReadOnly: true })).toBe('locked')
  })

  it('never reaches an editable body without a writable vault', () => {
    for (const vaultReadOnly of [true, false]) {
      // `cfg.readOnly` is `gate !== 'editing'`, and the metadata editors freeze
      // on `gate === 'locked'` — so this is the invariant both rest on.
      if (editGate({ vaultReadOnly }) === 'editing') expect(vaultReadOnly).toBe(false)
    }
  })
})
