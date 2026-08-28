import { describe, expect, it } from 'vitest'
import { editGate } from '../edit-gate'

/**
 * The two reasons a note body can be uneditable, and the one thing that must
 * never be true: `Edit` offered on a vault that cannot take an edit.
 */
describe('editGate', () => {
  it('lets the mode decide while the vault is writable', () => {
    expect(editGate({ vaultReadOnly: false, mode: 'read' })).toBe('reading')
    expect(editGate({ vaultReadOnly: false, mode: 'edit' })).toBe('editing')
  })

  it('reports locked whatever the mode says, including mid-edit', () => {
    expect(editGate({ vaultReadOnly: true, mode: 'read' })).toBe('locked')
    expect(editGate({ vaultReadOnly: true, mode: 'edit' })).toBe('locked')
  })

  it('never reaches an editable body without a writable vault', () => {
    for (const vaultReadOnly of [true, false]) {
      for (const mode of ['read', 'edit'] as const) {
        const gate = editGate({ vaultReadOnly, mode })
        // `cfg.readOnly` is `gate !== 'editing'`, and `Edit` is offered only on
        // `reading` — so this is the invariant both call sites rest on.
        if (gate === 'editing') expect(vaultReadOnly).toBe(false)
        if (gate === 'reading') expect(vaultReadOnly).toBe(false)
      }
    }
  })
})
