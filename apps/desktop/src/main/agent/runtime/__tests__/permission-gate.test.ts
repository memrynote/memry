import { describe, expect, it } from 'vitest'

import { decideToolGate } from '../permission-gate'

describe('decideToolGate', () => {
  it('auto-approves write tools by default', () => {
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

    expect(createDecision).toEqual({ outcome: 'auto_approve' })
    expect(updateDecision).toEqual({ outcome: 'auto_approve' })
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

    expect(decision).toEqual({ outcome: 'await_user', requiresDiff: false })
  })

  it('asks on update tools, regardless of trust list, when manual approval is enabled', () => {
    const decision = decideToolGate({
      toolName: 'vault_update_note',
      trustList: ['vault_update_note', 'vault_add_tag'],
      pendingDecision: null,
      toolApprovalMode: 'ask'
    })

    expect(decision).toEqual({ outcome: 'await_user', requiresDiff: true })
  })

  it('emits requiresDiff=true for vault_update_note specifically', () => {
    const decision = decideToolGate({
      toolName: 'vault_update_note',
      trustList: [],
      pendingDecision: null,
      toolApprovalMode: 'ask'
    })

    expect(decision).toMatchObject({ requiresDiff: true })
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
