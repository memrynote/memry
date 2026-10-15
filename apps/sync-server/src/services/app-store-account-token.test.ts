import { describe, expect, it } from 'vitest'

import { appAccountTokenForUser } from './app-store-account-token'

describe('appAccountTokenForUser', () => {
  it('uses a UUID user id as the token, lowercased', async () => {
    await expect(appAccountTokenForUser('6F9D2C1E-3B4A-4C5D-8E7F-0A1B2C3D4E5F')).resolves.toBe(
      '6f9d2c1e-3b4a-4c5d-8e7f-0a1b2c3d4e5f'
    )
  })

  it('derives a stable UUIDv5 for any other id', async () => {
    const token = await appAccountTokenForUser('legacy-user-1')
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    await expect(appAccountTokenForUser('legacy-user-1')).resolves.toBe(token)
    await expect(appAccountTokenForUser('legacy-user-2')).resolves.not.toBe(token)
  })
})
