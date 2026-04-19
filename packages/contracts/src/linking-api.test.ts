/**
 * Linking API Contract Tests
 */

import { describe, it, expect } from 'vitest'
import {
  InitiateLinkingRequestSchema,
  ScanLinkingRequestSchema,
  ApproveLinkingRequestSchema,
  CompleteLinkingRequestSchema,
  InitiateLinkingResponseSchema,
  ScanLinkingResponseSchema,
  ApproveLinkingResponseSchema,
  CompleteLinkingResponseSchema,
  LINKING_SESSION_STATUSES
} from './linking-api'

describe('LINKING_SESSION_STATUSES', () => {
  it('exposes the expected statuses', () => {
    expect(LINKING_SESSION_STATUSES).toEqual([
      'pending',
      'scanned',
      'approved',
      'completed',
      'expired'
    ])
  })
})

describe('InitiateLinkingRequestSchema', () => {
  it('accepts valid input', () => {
    const result = InitiateLinkingRequestSchema.safeParse({
      ephemeralPublicKey: 'pub-abc'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty ephemeralPublicKey', () => {
    const result = InitiateLinkingRequestSchema.safeParse({ ephemeralPublicKey: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('ephemeralPublicKey')
    }
  })

  it('rejects missing ephemeralPublicKey', () => {
    const result = InitiateLinkingRequestSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('ScanLinkingRequestSchema', () => {
  const validInput = {
    sessionId: 's1',
    newDevicePublicKey: 'np',
    newDeviceConfirm: 'nc',
    linkingSecret: 'ls',
    scanConfirm: 'sc',
    scanProof: 'sp'
  }

  it('accepts valid input', () => {
    const result = ScanLinkingRequestSchema.safeParse(validInput)
    expect(result.success).toBe(true)
  })

  it('rejects empty sessionId', () => {
    const result = ScanLinkingRequestSchema.safeParse({ ...validInput, sessionId: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('sessionId')
    }
  })

  it('rejects missing newDevicePublicKey', () => {
    const { newDevicePublicKey, ...rest } = validInput
    void newDevicePublicKey
    const result = ScanLinkingRequestSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects empty linkingSecret', () => {
    const result = ScanLinkingRequestSchema.safeParse({ ...validInput, linkingSecret: '' })
    expect(result.success).toBe(false)
  })

  it('rejects empty scanProof', () => {
    const result = ScanLinkingRequestSchema.safeParse({ ...validInput, scanProof: '' })
    expect(result.success).toBe(false)
  })
})

describe('ApproveLinkingRequestSchema', () => {
  it('accepts valid input', () => {
    const result = ApproveLinkingRequestSchema.safeParse({
      sessionId: 's1',
      encryptedMasterKey: 'emk',
      encryptedKeyNonce: 'ekn',
      keyConfirm: 'kc',
      encryptedProviderAuth: 'epa',
      encryptedProviderAuthNonce: 'epan',
      providerAuthConfirm: 'pac',
      providerAuthVersion: 1
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty encryptedMasterKey', () => {
    const result = ApproveLinkingRequestSchema.safeParse({
      sessionId: 's1',
      encryptedMasterKey: '',
      encryptedKeyNonce: 'ekn',
      keyConfirm: 'kc'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('encryptedMasterKey')
    }
  })

  it('rejects missing keyConfirm', () => {
    const result = ApproveLinkingRequestSchema.safeParse({
      sessionId: 's1',
      encryptedMasterKey: 'emk',
      encryptedKeyNonce: 'ekn'
    })
    expect(result.success).toBe(false)
  })

  it('rejects unsupported providerAuthVersion', () => {
    const result = ApproveLinkingRequestSchema.safeParse({
      sessionId: 's1',
      encryptedMasterKey: 'emk',
      encryptedKeyNonce: 'ekn',
      keyConfirm: 'kc',
      encryptedProviderAuth: 'epa',
      encryptedProviderAuthNonce: 'epan',
      providerAuthConfirm: 'pac',
      providerAuthVersion: 2
    })
    expect(result.success).toBe(false)
  })
})

describe('CompleteLinkingRequestSchema', () => {
  it('accepts valid input', () => {
    const result = CompleteLinkingRequestSchema.safeParse({ sessionId: 's1' })
    expect(result.success).toBe(true)
  })

  it('rejects empty sessionId', () => {
    const result = CompleteLinkingRequestSchema.safeParse({ sessionId: '' })
    expect(result.success).toBe(false)
  })
})

describe('InitiateLinkingResponseSchema', () => {
  it('accepts valid response', () => {
    const result = InitiateLinkingResponseSchema.safeParse({
      sessionId: 's1',
      expiresAt: 1744800000,
      linkingSecret: 'ls'
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-number expiresAt', () => {
    const result = InitiateLinkingResponseSchema.safeParse({
      sessionId: 's1',
      expiresAt: '2026-04-16',
      linkingSecret: 'ls'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('expiresAt')
    }
  })
})

describe('ScanLinkingResponseSchema', () => {
  it('accepts success only', () => {
    expect(ScanLinkingResponseSchema.safeParse({ success: true }).success).toBe(true)
  })

  it('accepts success + valid status', () => {
    const result = ScanLinkingResponseSchema.safeParse({ success: true, status: 'scanned' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid status', () => {
    const result = ScanLinkingResponseSchema.safeParse({ success: true, status: 'busy' })
    expect(result.success).toBe(false)
  })
})

describe('ApproveLinkingResponseSchema', () => {
  it('accepts success only', () => {
    expect(ApproveLinkingResponseSchema.safeParse({ success: false }).success).toBe(true)
  })

  it('accepts success + status', () => {
    const result = ApproveLinkingResponseSchema.safeParse({ success: true, status: 'approved' })
    expect(result.success).toBe(true)
  })

  it('rejects missing success', () => {
    const result = ApproveLinkingResponseSchema.safeParse({ status: 'approved' })
    expect(result.success).toBe(false)
  })
})

describe('CompleteLinkingResponseSchema', () => {
  it('accepts minimal response', () => {
    expect(CompleteLinkingResponseSchema.safeParse({ success: true }).success).toBe(true)
  })

  it('accepts full response', () => {
    const result = CompleteLinkingResponseSchema.safeParse({
      success: true,
      encryptedMasterKey: 'emk',
      encryptedKeyNonce: 'ekn',
      keyConfirm: 'kc',
      encryptedProviderAuth: 'epa',
      encryptedProviderAuthNonce: 'epan',
      providerAuthConfirm: 'pac',
      providerAuthVersion: 1
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-boolean success', () => {
    const result = CompleteLinkingResponseSchema.safeParse({ success: 'yes' })
    expect(result.success).toBe(false)
  })
})
