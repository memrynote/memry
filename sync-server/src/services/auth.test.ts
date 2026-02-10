import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'

const hoisted = vi.hoisted(() => ({
  importPkcs8Mock: vi.fn(async () => ({ key: 'private' })),
  signMock: vi.fn(async (claims: Record<string, unknown>) =>
    `token-${String(claims.type)}-${String(claims.sub)}-${String(claims.device_id)}`
  )
}))

vi.mock('jose', () => ({
  importPKCS8: hoisted.importPkcs8Mock,
  SignJWT: class {
    private claims: Record<string, unknown>

    constructor(claims: Record<string, unknown>) {
      this.claims = claims
    }

    setProtectedHeader() {
      return this
    }

    setIssuedAt() {
      return this
    }

    setIssuer() {
      return this
    }

    setAudience() {
      return this
    }

    setExpirationTime() {
      return this
    }

    sign() {
      return hoisted.signMock(this.claims)
    }
  }
}))

import { issueTokens, revokeDeviceTokens, rotateRefreshToken } from './auth'

function createAuthDb(existingTokenRow: { id: string } | null) {
  const runs: Array<{ sql: string; args: unknown[] }> = []

  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.startsWith('SELECT id FROM refresh_tokens')) {
            return existingTokenRow
          }
          return null
        },
        run: async () => {
          runs.push({ sql, args })
          return { success: true }
        }
      })
    })
  }

  return { db: db as unknown as D1Database, runs }
}

describe('auth service token lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('new-token-id')
    hoisted.importPkcs8Mock.mockResolvedValue({ key: 'private' })
    hoisted.signMock.mockImplementation(
      async (claims: Record<string, unknown>) =>
        `token-${String(claims.type)}-${String(claims.sub)}-${String(claims.device_id)}`
    )
  })

  it('issues access and refresh tokens with EdDSA signing flow', async () => {
    const tokens = await issueTokens('user-1', 'device-1', 'private-pem')

    expect(tokens.accessToken).toBe('token-access-user-1-device-1')
    expect(tokens.refreshToken).toBe('token-refresh-user-1-device-1')
    expect(hoisted.importPkcs8Mock).toHaveBeenCalledWith('private-pem', 'EdDSA')
  })

  it('invalidates all device refresh tokens when old token is missing', async () => {
    const { db, runs } = createAuthDb(null)

    await expect(
      rotateRefreshToken(db, 'old-token', 'user-1', 'device-1', 'private-pem')
    ).rejects.toMatchObject({
      code: ErrorCodes.AUTH_INVALID_TOKEN,
      statusCode: 401
    } satisfies Partial<AppError>)

    expect(runs).toEqual([
      {
        sql: 'UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND device_id = ?',
        args: ['user-1', 'device-1']
      }
    ])
  })

  it('rotates refresh token when current token is valid', async () => {
    const { db, runs } = createAuthDb({ id: 'existing-id' })

    const rotated = await rotateRefreshToken(db, 'old-token', 'user-1', 'device-1', 'private-pem')

    expect(rotated.accessToken).toBe('token-access-user-1-device-1')
    expect(rotated.refreshToken).toBe('token-refresh-user-1-device-1')

    expect(runs[0]).toEqual({
      sql: 'UPDATE refresh_tokens SET revoked = 1 WHERE id = ?',
      args: ['existing-id']
    })

    expect(runs[1].sql).toBe(
      'INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    expect(runs[1].args[0]).toBe('new-token-id')
    expect(runs[1].args[1]).toBe('user-1')
    expect(runs[1].args[2]).toBe('device-1')
    expect(typeof runs[1].args[3]).toBe('string')
    expect((runs[1].args[3] as string).length).toBe(64)
    expect(runs[1].args[4]).toBe(1_700_604_800)
    expect(runs[1].args[5]).toBe(1_700_000_000)
  })

  it('revokes all active refresh tokens for a removed device', async () => {
    const { db, runs } = createAuthDb(null)

    await revokeDeviceTokens(db, 'device-9')

    expect(runs).toEqual([
      {
        sql: 'UPDATE refresh_tokens SET revoked = 1 WHERE device_id = ? AND revoked = 0',
        args: ['device-9']
      }
    ])
  })
})
