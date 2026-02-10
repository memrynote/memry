import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

const hoisted = vi.hoisted(() => ({
  importSpkiMock: vi.fn(async () => ({ key: 'public' })),
  jwtVerifyMock: vi.fn(async () => ({
    payload: {
      sub: 'user-1',
      device_id: 'device-1',
      type: 'access'
    }
  }))
}))

vi.mock('jose', () => ({
  importSPKI: hoisted.importSpkiMock,
  jwtVerify: hoisted.jwtVerifyMock
}))

import { authMiddleware } from './auth'

function createContext(options?: {
  authHeader?: string
  device?: { id: string; revoked_at: string | null } | null
  jwtPublicKey?: string
}) {
  const authHeader = options?.authHeader ?? 'Bearer access-token'
  const device =
    options && 'device' in options ? options.device : { id: 'device-1', revoked_at: null }
  const jwtPublicKey = options?.jwtPublicKey ?? 'pem-key'

  const first = vi.fn(async () => device)
  const bind = vi.fn(() => ({ first }))
  const prepare = vi.fn(() => ({ bind }))

  const setMap = new Map<string, string>()

  const context = {
    req: {
      header: vi.fn((name: string) => (name === 'Authorization' ? authHeader : undefined))
    },
    env: {
      JWT_PUBLIC_KEY: jwtPublicKey,
      DB: { prepare }
    },
    set: vi.fn((key: string, value: string) => {
      setMap.set(key, value)
    })
  }

  return { context, setMap, first, prepare }
}

describe('auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.importSpkiMock.mockResolvedValue({ key: 'public' })
    hoisted.jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'user-1',
        device_id: 'device-1',
        type: 'access'
      }
    })
  })

  it('rejects missing or malformed Authorization header', async () => {
    const { context } = createContext({ authHeader: 'invalid-header' })

    await expect(authMiddleware(context as never, vi.fn(async () => undefined))).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('rejects invalid public key configuration', async () => {
    hoisted.importSpkiMock.mockRejectedValue(new Error('bad pem'))
    const { context } = createContext()

    await expect(authMiddleware(context as never, vi.fn(async () => undefined))).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 500
    } satisfies Partial<AppError>)
  })

  it('maps expired token verification failures to AUTH_TOKEN_EXPIRED', async () => {
    hoisted.jwtVerifyMock.mockRejectedValue(new Error('token expired'))
    const { context } = createContext()

    await expect(authMiddleware(context as never, vi.fn(async () => undefined))).rejects.toMatchObject({
      code: ErrorCodes.AUTH_TOKEN_EXPIRED,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('rejects tokens with missing required claims', async () => {
    hoisted.jwtVerifyMock.mockResolvedValue({ payload: { sub: 'user-1', type: 'access' } })
    const { context } = createContext()

    await expect(authMiddleware(context as never, vi.fn(async () => undefined))).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('rejects unknown and revoked devices', async () => {
    const missingContext = createContext({ device: null }).context

    await expect(
      authMiddleware(missingContext as never, vi.fn(async () => undefined))
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_DEVICE_NOT_FOUND,
      statusCode: 401
    } satisfies Partial<AppError>)

    const revokedContext = createContext({
      device: { id: 'device-1', revoked_at: '1700000000' }
    }).context

    await expect(
      authMiddleware(revokedContext as never, vi.fn(async () => undefined))
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_DEVICE_REVOKED,
      statusCode: 403
    } satisfies Partial<AppError>)
  })

  it('sets user and device context for valid access tokens', async () => {
    const { context, setMap } = createContext()
    const next = vi.fn(async () => undefined)

    await authMiddleware(context as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(setMap.get('userId')).toBe('user-1')
    expect(setMap.get('deviceId')).toBe('device-1')
  })
})
