import { describe, expect, it } from 'vitest'

import { decideToolGate } from '../permission-gate'

describe('decideToolGate', () => {
  /**
   * An absent mode means nobody has chosen, and the shipped default is now to
   * ask. Only an explicit `always_accept` skips the card. If this ever flips
   * back, an agent writes to a vault without showing the user anything.
   */
  it('asks when no approval mode has been chosen', () => {
    const createDecision = decideToolGate({
      toolName: 'vault_create_task',
      trustList: [],
      pendingDecision: null
    })
    const updateDecision = decideToolGate({
      toolName: 'vault_update_note',
      trustList: [],
      pendingDecision: null
    })

    expect(createDecision).toMatchObject({ outcome: 'await_user' })
    expect(updateDecision).toMatchObject({ outcome: 'await_user' })
  })

  it('auto-approves write tools when always_accept is explicitly chosen', () => {
    const decision = decideToolGate({
      toolName: 'vault_update_note',
      trustList: [],
      pendingDecision: null,
      toolApprovalMode: 'always_accept'
    })

    expect(decision).toEqual({ outcome: 'auto_approve' })
  })

  it('auto-approves read tools regardless of trust list', () => {
    const decision = decideToolGate({
      toolName: 'vault_read_note',
      trustList: [],
      pendingDecision: null,
      toolApprovalMode: 'ask'
    })

    expect(decision).toEqual({ outcome: 'auto_approve' })
  })

  it('auto-approves create tools that are in the trust list', () => {
    const decision = decideToolGate({
      toolName: 'vault_create_task',
      trustList: ['vault_create_task'],
      pendingDecision: null,
      toolApprovalMode: 'ask'
    })

    expect(decision).toEqual({ outcome: 'auto_approve' })
  })

  it('asks for approval on create tools not in trust list when manual approval is enabled', () => {
    const decision = decideToolGate({
      toolName: 'vault_create_task',
      trustList: [],
      pendingDecision: null,
      toolApprovalMode: 'ask'
    })

    expect(decision).toEqual({
      outcome: 'await_user',
      requiresDiff: true,
      previewKind: 'fields'
    })
  })

  it('asks on an update tool nobody has granted', () => {
    const decision = decideToolGate({
      toolName: 'vault_update_note',
      trustList: [],
      pendingDecision: null,
      toolApprovalMode: 'ask'
    })

    expect(decision).toEqual({
      outcome: 'await_user',
      requiresDiff: true,
      previewKind: 'body'
    })
  })

  /**
   * A standing approval has to mean what it says. It used to be read only for
   * create tools, so granting one on an update left the card appearing every
   * time and the grant looking broken.
   */
  it('honours a standing approval on an update tool, at either scope', () => {
    expect(
      decideToolGate({
        toolName: 'vault_update_note',
        trustList: ['vault_update_note'],
        pendingDecision: null,
        toolApprovalMode: 'ask'
      })
    ).toEqual({ outcome: 'auto_approve' })

    expect(
      decideToolGate({
        toolName: 'vault_update_task',
        trustList: [],
        vaultTrustList: ['vault_update_task'],
        pendingDecision: null,
        toolApprovalMode: 'ask'
      })
    ).toEqual({ outcome: 'auto_approve' })
  })

  /**
   * The one write a standing approval must never cover. "Always allow" is a
   * promise about work the user can still look at afterwards, and a delete is
   * where that stops being true, so the gate refuses the grant rather than
   * trusting the list.
   */
  it('refuses to trust a delete at either scope', () => {
    for (const toolName of ['vault_delete_note', 'vault_delete_task']) {
      expect(
        decideToolGate({
          toolName,
          trustList: [toolName],
          vaultTrustList: [toolName],
          pendingDecision: null,
          toolApprovalMode: 'ask'
        })
      ).toEqual({ outcome: 'await_user', requiresDiff: true, previewKind: 'loss' })
    }
  })

  /**
   * The whole point of the change: a preview is owed for every write, in the
   * shape that fits the item. A regression here does not fail loudly, it just
   * shows raw JSON args again for everything that is not a note body.
   */
  it.each([
    ['vault_update_note', 'body'],
    ['vault_create_note', 'body'],
    ['vault_update_journal_entry', 'body'],
    ['vault_add_to_inbox', 'body'],
    ['vault_update_task', 'fields'],
    ['vault_complete_task', 'fields'],
    ['vault_snooze_inbox_item', 'fields'],
    ['vault_move_to_folder', 'fields'],
    ['vault_archive_task', 'fields'],
    ['vault_delete_note', 'loss'],
    ['vault_delete_task', 'loss'],
    ['vault_delete_journal_entry', 'loss'],
    ['vault_delete_inbox_item', 'loss'],
    ['vault_delete_folder', 'loss']
  ])('asks for a %s preview shaped as %s', (toolName, previewKind) => {
    const decision = decideToolGate({
      toolName,
      trustList: [],
      pendingDecision: null,
      toolApprovalMode: 'ask'
    })

    expect(decision).toEqual({ outcome: 'await_user', requiresDiff: true, previewKind })
  })

  /**
   * Archiving is reversible and must not be dressed as a loss, or the loss
   * signal stops meaning anything on the one card where it matters.
   */
  it('does not treat archiving as a loss', () => {
    expect(
      decideToolGate({
        toolName: 'vault_archive_project',
        trustList: [],
        pendingDecision: null,
        toolApprovalMode: 'ask'
      })
    ).toMatchObject({ previewKind: 'fields' })
  })

  it('still asks for a tool the preview table does not know', () => {
    const decision = decideToolGate({
      toolName: 'vault_invent_something',
      trustList: [],
      pendingDecision: null,
      toolApprovalMode: 'ask'
    })

    expect(decision).toEqual({
      outcome: 'await_user',
      requiresDiff: false,
      previewKind: 'none'
    })
  })

  it('forwards an existing decision without re-asking', () => {
    const decision = decideToolGate({
      toolName: 'vault_create_task',
      trustList: [],
      pendingDecision: { kind: 'allow' }
    })

    expect(decision).toEqual({ outcome: 'apply_decision', decision: { kind: 'allow' } })
  })
})
