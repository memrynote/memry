import { describe, it, expect } from 'vitest'

import { settingsRoutes } from './settings'

describe('settingsRoutes', () => {
  it('settings_get returns a full settings object with realistic defaults', async () => {
    const settings = (await settingsRoutes.settings_get!(undefined)) as {
      appearance: { theme: string }
      editor: { fontSize: number }
      sync: { enabled: boolean }
      ai: { provider: string }
      privacy: Record<string, boolean>
    }
    expect(settings.appearance.theme).toBeDefined()
    expect(settings.editor.fontSize).toBeGreaterThan(0)
    expect(typeof settings.sync.enabled).toBe('boolean')
    expect(typeof settings.ai.provider).toBe('string')
    expect(typeof settings.privacy).toBe('object')
  })

  it('settings_update merges partial updates and returns the new state', async () => {
    const updated = (await settingsRoutes.settings_update!({
      appearance: { theme: 'dark' }
    })) as { appearance: { theme: string } }
    expect(updated.appearance.theme).toBe('dark')
  })

  it('settings_reset restores defaults', async () => {
    await settingsRoutes.settings_update!({ appearance: { theme: 'dark' } })
    const reset = (await settingsRoutes.settings_reset!(undefined)) as {
      appearance: { theme: string }
    }
    expect(reset.appearance.theme).toBe('system')
  })

  it('settings_get_section returns a specific section', async () => {
    const editor = (await settingsRoutes.settings_get_section!({
      section: 'editor'
    })) as { fontSize: number }
    expect(editor.fontSize).toBeGreaterThan(0)
  })

  it('settings_get_section rejects unknown section', async () => {
    await expect(
      settingsRoutes.settings_get_section!({ section: 'bogus' })
    ).rejects.toThrow(/unknown settings section/i)
  })

  it('settings_get_general_settings returns the general defaults (onboardingCompleted=false)', async () => {
    await settingsRoutes.settings_reset!(undefined)
    const general = (await settingsRoutes.settings_get_general_settings!(undefined)) as {
      onboardingCompleted: boolean
      theme: string
      clockFormat: string
    }
    expect(general.onboardingCompleted).toBe(false)
    expect(general.theme).toBe('system')
    expect(general.clockFormat).toBe('12h')
  })

  it('settings_set_general_settings persists the onboarding flag', async () => {
    await settingsRoutes.settings_reset!(undefined)
    const result = (await settingsRoutes.settings_set_general_settings!({
      onboardingCompleted: true
    })) as { success: boolean }
    expect(result.success).toBe(true)

    const general = (await settingsRoutes.settings_get_general_settings!(undefined)) as {
      onboardingCompleted: boolean
    }
    expect(general.onboardingCompleted).toBe(true)
  })
})
