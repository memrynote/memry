import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

const hoisted = vi.hoisted(() => ({
  importSpkiMock: vi.fn(async () => ({ key: 'public' })),
  jwtVerifyMock: vi.fn(async () => ({
    payload: {
      sub: 'user-1',
      type: 'setup',
      jti: 'setup-jti-1'
    }
  }))
}))

vi.mock('jose', () => ({
  importSPKI: hoisted.importSpkiMock,
  jwtVerify: hoisted.jwtVerifyMock
}))

import { setupAuthMiddleware } from './setup-auth'

function createContext(options?: { authHeader?: string | null; jwtPublicKey?: string }) {
  const authHeader = options && 'authHeader' in options ? options.authHeader : 'Bearer setup-token'
  const jwtPublicKey = options?.jwtPublicKey ?? 'pem-key'

  const setMap = new Map<string, string>()

  const context = {
    req: {
      header: vi.fn((name: string) =>
        name === 'Authorization' ? (authHeader ?? undefined) : undefined
      )
    },
    env: {
      JWT_PUBLIC_KEY: jwtPublicKey
    },
    set: vi.fn((key: string, value: string) => {
      setMap.set(key, value)
    })
  }

  return { context, setMap }
}

describe('setup-auth middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hoisted.importSpkiMock.mockResolvedValue({ key: 'public' })
    hoisted.jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'user-1',
        type: 'setup',
        jti: 'setup-jti-1'
      }
    })
  })

  it('rejects when Authorization header is missing', async () => {
    // #given
    const { context } = createContext({ authHeader: null })

    // #when / #then
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('rejects when Authorization header has no Bearer prefix', async () => {
    // #given
    const { context } = createContext({ authHeader: 'Basic some-token' })

    // #when / #then
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('passes empty bearer token through to jwtVerify for rejection', async () => {
    // #given
    hoisted.jwtVerifyMock.mockRejectedValue(new Error('Invalid compact JWS'))
    const { context } = createContext({ authHeader: 'Bearer ' })

    // #when / #then
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('returns INTERNAL_ERROR when public key configuration is invalid', async () => {
    // #given
    hoisted.importSpkiMock.mockRejectedValue(new Error('bad pem'))
    const { context } = createContext({ jwtPublicKey: 'bad-pem-key' })

    // #when / #then
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.INTERNAL_ERROR,
      statusCode: 500
    } satisfies Partial<AppError>)
  })

  it('maps expired token to AUTH_TOKEN_EXPIRED', async () => {
    // #given
    hoisted.jwtVerifyMock.mockRejectedValue(new Error('token expired'))
    const { context } = createContext()

    // #when / #then
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_TOKEN_EXPIRED,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('rejects tokens with invalid signature', async () => {
    // #given
    hoisted.jwtVerifyMock.mockRejectedValue(new Error('signature verification failed'))
    const { context } = createContext()

    // #when / #then
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('rejects tokens with wrong type (access instead of setup)', async () => {
    // #given
    hoisted.jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'user-1', type: 'access' }
    } as never)
    const { context } = createContext()

    // #when / #then
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('rejects tokens with missing sub claim', async () => {
    // #given
    hoisted.jwtVerifyMock.mockResolvedValue({
      payload: { type: 'setup' }
    } as never)
    const { context } = createContext()

    // #when / #then
    await expect(
      setupAuthMiddleware(
        context as never,
        vi.fn(async () => undefined)
      )
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)
  })

  it('sets userId and calls next() for valid setup tokens', async () => {
    // #given
    const { context, setMap } = createContext()
    const next = vi.fn(async () => undefined)

    // #when
    await setupAuthMiddleware(context as never, next)

    // #then
    expect(next).toHaveBeenCalledTimes(1)
    expect(setMap.get('userId')).toBe('user-1')
    expect(setMap.get('tokenJti')).toBe('setup-jti-1')
  })

  it('does not query the database for device lookup', async () => {
    // #given
    const { context } = createContext()
    const next = vi.fn(async () => undefined)

    // #when
    await setupAuthMiddleware(context as never, next)

    // #then
    expect(context.env).not.toHaveProperty('DB')
  })
})
