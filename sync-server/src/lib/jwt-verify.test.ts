import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  importSpkiMock: vi.fn(async () => ({ key: 'public' })),
  jwtVerifyMock: vi.fn(async () => ({
    payload: {
      sub: 'user-1',
      device_id: 'device-1',
      type: 'access',
      exp: 9999999999
    } as Record<string, unknown>
  }))
}))

vi.mock('jose', () => ({
  importSPKI: hoisted.importSpkiMock,
  jwtVerify: hoisted.jwtVerifyMock
}))

import { verifyAccessToken } from './jwt-verify'

describe('verifyAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.importSpkiMock.mockResolvedValue({ key: 'public' })
    hoisted.jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'user-1',
        device_id: 'device-1',
        type: 'access',
        exp: 9999999999
      }
    })
  })

  it('returns claims for a valid access token', async () => {
    // #when
    const claims = await verifyAccessToken('valid-token', 'pem-key')

    // #then
    expect(claims).toEqual({
      userId: 'user-1',
      deviceId: 'device-1',
      exp: 9999999999
    })
  })

  it('throws on expired token', async () => {
    // #given
    hoisted.jwtVerifyMock.mockRejectedValue(new Error('token expired'))

    // #when / #then
    await expect(verifyAccessToken('expired-token', 'pem-key')).rejects.toThrow('token expired')
  })

  it('throws on refresh token type', async () => {
    // #given
    hoisted.jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'user-1', device_id: 'device-1', type: 'refresh', exp: 9999999999 }
    })

    // #when / #then
    await expect(verifyAccessToken('refresh-token', 'pem-key')).rejects.toThrow(
      'Invalid token type'
    )
  })

  it('throws when sub is missing', async () => {
    // #given
    hoisted.jwtVerifyMock.mockResolvedValue({
      payload: { device_id: 'device-1', type: 'access', exp: 9999999999 }
    })

    // #when / #then
    await expect(verifyAccessToken('no-sub-token', 'pem-key')).rejects.toThrow(
      'Token missing required claims'
    )
  })

  it('throws when device_id is missing', async () => {
    // #given
    hoisted.jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'user-1', type: 'access', exp: 9999999999 }
    })

    // #when / #then
    await expect(verifyAccessToken('no-device-token', 'pem-key')).rejects.toThrow(
      'Token missing required claims'
    )
  })

  it('passes correct verification options to jose', async () => {
    // #when
    await verifyAccessToken('any-token', 'test-pem')

    // #then
    expect(hoisted.jwtVerifyMock).toHaveBeenCalledWith(
      'any-token',
      { key: 'public' },
      {
        algorithms: ['EdDSA'],
        issuer: 'memry-sync',
        audience: 'memry-client'
      }
    )
  })
})
