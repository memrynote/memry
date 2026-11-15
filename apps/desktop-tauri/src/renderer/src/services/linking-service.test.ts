import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LINK_FAILURE_SETUP_SESSION_EXPIRED } from '@memry/contracts/ipc-devices'

const mocks = vi.hoisted(() => ({
  commands: {
    syncLinkViaQr: vi.fn(),
    syncCompleteLinkingQr: vi.fn(),
    syncGetLinkingSas: vi.fn(),
    syncFinalizeVaultChoice: vi.fn()
  }
}))

vi.mock('../../../generated/bindings', () => ({ commands: mocks.commands }))

import { LINK_NOT_APPROVED, linkingService } from './linking-service'

const rejected = (code: string, message: string) => ({ kind: 'auth', code, message })

describe('linking-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers each poll in the envelope the pending screen polls past or stops on', async () => {
    mocks.commands.syncCompleteLinkingQr
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValueOnce({ status: 'rateLimited' })
      .mockResolvedValueOnce({ status: 'linked', vaults: null })
      .mockResolvedValueOnce({ status: 'linked', vaults: ['v-1', 'v-2'] })
      .mockRejectedValueOnce(rejected('linking_no_session', 'No pending linking session found'))

    const poll = () => linkingService.completeLinkingQr({ sessionId: 's-1' })
    await expect(poll()).resolves.toEqual({ success: false, error: LINK_NOT_APPROVED })
    expect((await poll()).error).toContain('Too many requests')
    await expect(poll()).resolves.toEqual({ success: true, vaults: undefined })
    await expect(poll()).resolves.toEqual({
      success: true,
      vaults: [{ vaultUuid: 'v-1' }, { vaultUuid: 'v-2' }]
    })
    await expect(poll()).resolves.toEqual({
      success: false,
      error: 'No pending linking session found'
    })
    expect(mocks.commands.syncCompleteLinkingQr).toHaveBeenCalledWith('s-1')
  })

  it('carries the setup-expired code on a scan whose sign-in ran out', async () => {
    mocks.commands.syncLinkViaQr
      .mockResolvedValueOnce({ sessionId: 's-1', verificationCode: '123456' })
      .mockRejectedValueOnce(rejected('setup_session_expired', 'Sign in again.'))

    await expect(linkingService.linkViaQr({ qrData: '{}' })).resolves.toEqual({
      success: true,
      status: 'waiting_approval',
      verificationCode: '123456'
    })
    await expect(linkingService.linkViaQr({ qrData: '{}' })).resolves.toEqual({
      success: false,
      error: 'Sign in again.',
      errorCode: LINK_FAILURE_SETUP_SESSION_EXPIRED
    })
  })

  it('answers the code comparison and the vault choice as Electron did', async () => {
    mocks.commands.syncGetLinkingSas
      .mockResolvedValueOnce('654321')
      .mockRejectedValueOnce(rejected('linking_not_scanned', 'Session has not been scanned yet'))
    mocks.commands.syncFinalizeVaultChoice.mockRejectedValueOnce(
      rejected('linking_vault_choice_failed', 'Could not create /x')
    )

    await expect(linkingService.getLinkingSas({ sessionId: 's-1' })).resolves.toEqual({
      verificationCode: '654321'
    })
    await expect(linkingService.getLinkingSas({ sessionId: 's-1' })).resolves.toEqual({
      error: 'Session has not been scanned yet'
    })
    await expect(
      linkingService.finalizeVaultChoice({
        sessionId: 's-1',
        parentFolderPath: '/x',
        selectedVaultUuids: ['v-1'],
        primaryVaultUuid: 'v-1'
      })
    ).resolves.toEqual({ success: false, error: 'Could not create /x' })
    expect(mocks.commands.syncFinalizeVaultChoice).toHaveBeenCalledWith('s-1', '/x', ['v-1'], 'v-1')
  })
})
