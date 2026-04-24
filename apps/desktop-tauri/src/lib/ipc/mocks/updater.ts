import type { MockRouteMap } from './types'

interface UpdaterSettings {
  autoCheck: boolean
  channel: 'stable' | 'beta' | 'nightly'
  lastCheckedAt: number | null
}

let settings: UpdaterSettings = {
  autoCheck: true,
  channel: 'stable',
  lastCheckedAt: null
}

const currentVersion = '2.0.0-alpha.1'

export const updaterRoutes: MockRouteMap = {
  updater_check: async () => {
    settings = { ...settings, lastCheckedAt: Date.now() }
    return {
      available: false,
      currentVersion,
      latestVersion: null,
      releaseNotes: null,
      checkedAt: settings.lastCheckedAt
    }
  },
  updater_download: async () => ({ ok: true, progress: 0 }),
  updater_install: async () => ({
    ok: false,
    reason: 'updater-not-implemented-in-m1'
  }),
  updater_cancel: async () => ({ ok: true }),
  updater_settings_get: async () => settings,
  updater_settings_update: async (args) => {
    const patch = args as Partial<UpdaterSettings>
    settings = { ...settings, ...patch }
    return settings
  }
}
