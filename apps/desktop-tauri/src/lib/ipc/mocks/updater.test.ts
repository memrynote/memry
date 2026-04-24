import { describe, it, expect } from 'vitest'

import { updaterRoutes } from './updater'

describe('updaterRoutes', () => {
  it('updater_check returns a no-update-available response by default', async () => {
    const res = (await updaterRoutes.updater_check!(undefined)) as {
      available: boolean
      currentVersion: string
      latestVersion: string | null
    }
    expect(res.available).toBe(false)
    expect(typeof res.currentVersion).toBe('string')
  })

  it('updater_download returns ok with a mocked progress report', async () => {
    const res = (await updaterRoutes.updater_download!(undefined)) as {
      ok: boolean
      progress: number
    }
    expect(res.ok).toBe(true)
    expect(typeof res.progress).toBe('number')
  })

  it('updater_install returns ok but notes m1 cannot actually install', async () => {
    const res = (await updaterRoutes.updater_install!(undefined)) as {
      ok: boolean
      reason: string
    }
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/m1/i)
  })

  it('updater_settings_get returns the updater settings', async () => {
    const settings = (await updaterRoutes.updater_settings_get!(undefined)) as {
      autoCheck: boolean
      channel: string
    }
    expect(typeof settings.autoCheck).toBe('boolean')
    expect(typeof settings.channel).toBe('string')
  })

  it('updater_settings_update merges the patch', async () => {
    const settings = (await updaterRoutes.updater_settings_update!({
      autoCheck: false
    })) as { autoCheck: boolean }
    expect(settings.autoCheck).toBe(false)
  })
})
