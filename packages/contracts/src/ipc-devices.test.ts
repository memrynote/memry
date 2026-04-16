/**
 * IPC Devices Contract Tests
 *
 * Zod schema validation tests for the device-management IPC boundary:
 * QR linking, recovery-phrase linking, SAS retrieval, approval,
 * and device removal / rename. Device revocation must reject a
 * missing deviceId — asserted explicitly.
 */

import { describe, expect, it } from 'vitest'
import {
  ApproveLinkingSchema,
  CompleteLinkingQrSchema,
  DEVICE_CHANNELS,
  GetLinkingSasSchema,
  LinkViaQrSchema,
  LinkViaRecoverySchema,
  RemoveDeviceSchema,
  RenameDeviceSchema
} from './ipc-devices'

describe('DEVICE_CHANNELS', () => {
  it('exposes every expected device channel literal', () => {
    expect(DEVICE_CHANNELS.GENERATE_LINKING_QR).toBe('sync:generate-linking-qr')
    expect(DEVICE_CHANNELS.LINK_VIA_QR).toBe('sync:link-via-qr')
    expect(DEVICE_CHANNELS.COMPLETE_LINKING_QR).toBe('sync:complete-linking-qr')
    expect(DEVICE_CHANNELS.LINK_VIA_RECOVERY).toBe('sync:link-via-recovery')
    expect(DEVICE_CHANNELS.APPROVE_LINKING).toBe('sync:approve-linking')
    expect(DEVICE_CHANNELS.GET_LINKING_SAS).toBe('sync:get-linking-sas')
    expect(DEVICE_CHANNELS.GET_DEVICES).toBe('sync:get-devices')
    expect(DEVICE_CHANNELS.REMOVE_DEVICE).toBe('sync:remove-device')
    expect(DEVICE_CHANNELS.RENAME_DEVICE).toBe('sync:rename-device')
  })
})

describe('LinkViaQrSchema', () => {
  it('accepts minimal valid input', () => {
    const result = LinkViaQrSchema.safeParse({ qrData: 'qr-payload' })
    expect(result.success).toBe(true)
  })

  it('accepts optional oauthToken + provider', () => {
    const result = LinkViaQrSchema.safeParse({
      qrData: 'qr-payload',
      oauthToken: 'token',
      provider: 'google'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty qrData', () => {
    const result = LinkViaQrSchema.safeParse({ qrData: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('qrData')
    }
  })

  it('rejects missing qrData', () => {
    const result = LinkViaQrSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('LinkViaRecoverySchema', () => {
  it('accepts a non-empty recovery phrase', () => {
    const result = LinkViaRecoverySchema.safeParse({ recoveryPhrase: 'twelve words here' })
    expect(result.success).toBe(true)
  })

  it('rejects an empty recovery phrase', () => {
    const result = LinkViaRecoverySchema.safeParse({ recoveryPhrase: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('recoveryPhrase')
    }
  })

  it('rejects missing recovery phrase', () => {
    const result = LinkViaRecoverySchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('CompleteLinkingQrSchema', () => {
  it('accepts a valid sessionId', () => {
    const result = CompleteLinkingQrSchema.safeParse({ sessionId: 'session-1' })
    expect(result.success).toBe(true)
  })

  it('rejects empty sessionId', () => {
    const result = CompleteLinkingQrSchema.safeParse({ sessionId: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing sessionId', () => {
    const result = CompleteLinkingQrSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('GetLinkingSasSchema', () => {
  it('accepts a valid sessionId', () => {
    const result = GetLinkingSasSchema.safeParse({ sessionId: 'session-1' })
    expect(result.success).toBe(true)
  })

  it('rejects empty sessionId', () => {
    const result = GetLinkingSasSchema.safeParse({ sessionId: '' })
    expect(result.success).toBe(false)
  })
})

describe('ApproveLinkingSchema', () => {
  it('accepts a valid sessionId', () => {
    const result = ApproveLinkingSchema.safeParse({ sessionId: 'session-1' })
    expect(result.success).toBe(true)
  })

  it('rejects empty sessionId', () => {
    const result = ApproveLinkingSchema.safeParse({ sessionId: '' })
    expect(result.success).toBe(false)
  })
})

describe('RemoveDeviceSchema', () => {
  it('accepts a valid deviceId (revocation path)', () => {
    const result = RemoveDeviceSchema.safeParse({ deviceId: 'dev-1' })
    expect(result.success).toBe(true)
  })

  it('rejects missing deviceId — revocation must not be silently no-op', () => {
    const result = RemoveDeviceSchema.safeParse({})
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('deviceId')
    }
  })

  it('rejects empty deviceId string', () => {
    const result = RemoveDeviceSchema.safeParse({ deviceId: '' })
    expect(result.success).toBe(false)
  })
})

describe('RenameDeviceSchema', () => {
  it('accepts a valid deviceId + newName', () => {
    const result = RenameDeviceSchema.safeParse({ deviceId: 'dev-1', newName: 'Kaan MBP' })
    expect(result.success).toBe(true)
  })

  it('accepts a newName exactly at the 100-char boundary', () => {
    const result = RenameDeviceSchema.safeParse({
      deviceId: 'dev-1',
      newName: 'x'.repeat(100)
    })
    expect(result.success).toBe(true)
  })

  it('rejects a newName over 100 characters', () => {
    const result = RenameDeviceSchema.safeParse({
      deviceId: 'dev-1',
      newName: 'x'.repeat(101)
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('newName')
    }
  })

  it('rejects empty newName', () => {
    const result = RenameDeviceSchema.safeParse({ deviceId: 'dev-1', newName: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing deviceId', () => {
    const result = RenameDeviceSchema.safeParse({ newName: 'Kaan MBP' })
    expect(result.success).toBe(false)
  })

  it('rejects missing newName', () => {
    const result = RenameDeviceSchema.safeParse({ deviceId: 'dev-1' })
    expect(result.success).toBe(false)
  })
})
