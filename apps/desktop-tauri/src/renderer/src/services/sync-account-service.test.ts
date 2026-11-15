import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commands: {
    syncLogout: vi.fn(),
    syncGetVaultBinding: vi.fn(),
    syncResolveVaultBinding: vi.fn()
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>()
}))

vi.mock('../../../generated/bindings', () => {
  const event = (name: string) => ({
    listen: vi.fn(async (handler: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, handler)
      return () => mocks.listeners.delete(name)
    })
  })
  return {
    commands: mocks.commands,
    events: {
      authSessionExpiredEvent: event('expired'),
      syncDeviceRemovedEvent: event('revoked'),
      syncLinkingRequestedEvent: event('linking-request'),
      syncLinkingApprovedEvent: event('linking-approved'),
      syncVaultBindingChangedEvent: event('binding')
    }
  }
})

import {
  onDeviceRevoked,
  onLinkingApproved,
  onLinkingRequest,
  onSessionExpired,
  onVaultBindingChanged,
  syncAccountService
} from './sync-account-service'

describe('sync-account-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listeners.clear()
  })

  it('answers logout in the Electron envelope, with a keychain warning only when there is one', async () => {
    mocks.commands.syncLogout
      .mockResolvedValueOnce({ success: true, keychainWarning: null })
      .mockResolvedValueOnce({ success: true, keychainWarning: 'Keychain locked' })

    await expect(syncAccountService.logout()).resolves.toEqual({ success: true })
    await expect(syncAccountService.logout()).resolves.toEqual({
      success: true,
      keychainWarning: 'Keychain locked'
    })
  })

  it('reads the binding and passes the choice through, dropping an empty error', async () => {
    const decision = { status: 'needs-decision', accountVaultCount: 2, mergeTarget: null }
    mocks.commands.syncGetVaultBinding.mockResolvedValueOnce(decision)
    await expect(syncAccountService.getVaultBinding()).resolves.toEqual(decision)

    mocks.commands.syncResolveVaultBinding
      .mockResolvedValueOnce({ success: true, state: { status: 'local-only' }, error: null })
      .mockResolvedValueOnce({ success: false, state: decision, error: 'Not allowed' })

    await expect(syncAccountService.resolveVaultBinding('local')).resolves.toEqual({
      success: true,
      state: { status: 'local-only' }
    })
    await expect(syncAccountService.resolveVaultBinding('merge')).resolves.toEqual({
      success: false,
      state: decision,
      error: 'Not allowed'
    })
    expect(mocks.commands.syncResolveVaultBinding.mock.calls).toEqual([['local'], ['merge']])
  })

  it('delivers each account event to its subscriber until it unsubscribes', async () => {
    const seen: Array<[string, unknown]> = []
    const stops = [
      onSessionExpired((e) => seen.push(['expired', e])),
      onDeviceRevoked((e) => seen.push(['revoked', e])),
      onLinkingRequest((e) => seen.push(['linking-request', e])),
      onLinkingApproved((e) => seen.push(['linking-approved', e])),
      onVaultBindingChanged((e) => seen.push(['binding', e]))
    ]
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(5))

    const payloads: Record<string, unknown> = {
      expired: { reason: 'refresh_rejected' },
      revoked: { unsyncedCount: 3 },
      'linking-request': { sessionId: 's-1', newDeviceName: 'Laptop' },
      'linking-approved': { sessionId: 's-1' },
      binding: { status: 'foreign' }
    }
    for (const [name, payload] of Object.entries(payloads)) {
      mocks.listeners.get(name)?.({ payload })
    }
    expect(seen).toEqual(Object.entries(payloads))

    for (const stop of stops) stop()
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(0))
  })
})
