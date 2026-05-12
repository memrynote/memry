import keytar from 'keytar'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn()
  }
}))

import {
  getLocalProviderApiKey,
  hasLocalProviderApiKey,
  setLocalProviderApiKey
} from '../local-provider-keychain'

describe('local provider keychain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.MEMRY_DEVICE
  })

  it('reads the default local provider API key account', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValueOnce('secret').mockResolvedValueOnce(null)

    await expect(getLocalProviderApiKey()).resolves.toBe('secret')
    await expect(hasLocalProviderApiKey()).resolves.toBe(false)

    expect(keytar.getPassword).toHaveBeenNthCalledWith(1, 'memry.agent.local-provider', 'api-key')
    expect(keytar.getPassword).toHaveBeenNthCalledWith(2, 'memry.agent.local-provider', 'api-key')
  })

  it('scopes the keychain account by MEMRY_DEVICE when available', async () => {
    process.env.MEMRY_DEVICE = ' device-1 '

    await setLocalProviderApiKey('secret')

    expect(keytar.setPassword).toHaveBeenCalledWith(
      'memry.agent.local-provider',
      'api-key:device-1',
      'secret'
    )
  })

  it('deletes the keychain value for null or empty input', async () => {
    await setLocalProviderApiKey(null)
    await setLocalProviderApiKey('')

    expect(keytar.deletePassword).toHaveBeenNthCalledWith(
      1,
      'memry.agent.local-provider',
      'api-key'
    )
    expect(keytar.deletePassword).toHaveBeenNthCalledWith(
      2,
      'memry.agent.local-provider',
      'api-key'
    )
  })
})
