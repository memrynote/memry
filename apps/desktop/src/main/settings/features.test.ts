import { describe, expect, it, vi, beforeEach } from 'vitest'
import { FEATURES_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getSetting: vi.fn(),
  deleteSetting: vi.fn()
}))

vi.mock('../database', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('../database/queries/settings', () => ({
  getSetting: mocks.getSetting,
  deleteSetting: mocks.deleteSetting
}))

import { getFeaturesSettings } from './features'

describe('getFeaturesSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue({} as never)
  })

  it('returns defaults when no vault is open', () => {
    mocks.getDatabase.mockImplementation(() => {
      throw new Error('No vault is open')
    })

    expect(getFeaturesSettings()).toEqual(FEATURES_SETTINGS_DEFAULTS)
    expect(mocks.getSetting).not.toHaveBeenCalled()
  })

  it('returns defaults when the group has never been written', () => {
    mocks.getSetting.mockReturnValue(undefined)

    expect(getFeaturesSettings()).toEqual(FEATURES_SETTINGS_DEFAULTS)
  })

  it('merges a stored partial over the defaults', () => {
    mocks.getSetting.mockReturnValue(JSON.stringify({ spatialCanvas: true }))

    const settings = getFeaturesSettings()

    expect(settings.spatialCanvas).toBe(true)
    // Every other flag keeps its default rather than becoming undefined.
    expect(settings.inbox).toBe(FEATURES_SETTINGS_DEFAULTS.inbox)
  })

  it('defaults spatialCanvas off, matching the opt-in rollout', () => {
    mocks.getSetting.mockReturnValue(undefined)

    expect(getFeaturesSettings().spatialCanvas).toBe(false)
  })

  it('falls back to defaults on a corrupt blob WITHOUT deleting it', () => {
    mocks.getSetting.mockReturnValue('{not json')

    expect(getFeaturesSettings()).toEqual(FEATURES_SETTINGS_DEFAULTS)
    // Deliberate difference from ipc/settings-handlers readGroupSettings: a flag
    // lookup on a tool call must never mutate the user's settings as a side
    // effect, so the corrupt key is left for the IPC path to repair.
    expect(mocks.deleteSetting).not.toHaveBeenCalled()
  })

  it('reads the "features" group key', () => {
    mocks.getSetting.mockReturnValue(undefined)

    getFeaturesSettings()

    expect(mocks.getSetting).toHaveBeenCalledWith(expect.anything(), 'features')
  })
})
