import type { MockRouteMap } from './types'

interface MockGeneralSettings {
  theme: 'system' | 'light' | 'dark' | 'white'
  fontSize: 'small' | 'medium' | 'large'
  fontFamily: string
  accentColor: string
  startOnBoot: boolean
  language: string
  onboardingCompleted: boolean
  createInSelectedFolder: boolean
  clockFormat: '12h' | '24h'
}

interface MockSettings {
  appearance: {
    theme: 'light' | 'dark' | 'system'
    fontFamily: string
    accentColor: string
  }
  editor: {
    fontSize: number
    lineHeight: number
    spellCheck: boolean
    autosaveIntervalMs: number
  }
  sync: {
    enabled: boolean
    serverUrl: string
    lastSyncedAt: number | null
  }
  ai: {
    provider: 'anthropic' | 'openai' | 'none'
    model: string
    apiKeyMasked: string
  }
  privacy: {
    telemetry: boolean
    crashReports: boolean
    shareDiagnostics: boolean
  }
  shortcuts: Record<string, string>
  general: MockGeneralSettings
}

function defaults(): MockSettings {
  return {
    appearance: {
      theme: 'system',
      fontFamily: 'Inter',
      accentColor: '#60a5fa'
    },
    editor: {
      fontSize: 14,
      lineHeight: 1.6,
      spellCheck: true,
      autosaveIntervalMs: 3000
    },
    sync: {
      enabled: false,
      serverUrl: 'https://sync.memry.mock',
      lastSyncedAt: null
    },
    ai: {
      provider: 'none',
      model: 'claude-sonnet-4-6',
      apiKeyMasked: ''
    },
    privacy: {
      telemetry: false,
      crashReports: true,
      shareDiagnostics: false
    },
    shortcuts: {
      quickCapture: 'Cmd+Shift+N',
      search: 'Cmd+K',
      toggleSidebar: 'Cmd+\\'
    },
    general: {
      theme: 'system',
      fontSize: 'medium',
      fontFamily: 'system',
      accentColor: '#6366f1',
      startOnBoot: false,
      language: 'en',
      onboardingCompleted: false,
      createInSelectedFolder: true,
      clockFormat: '12h'
    }
  }
}

let state: MockSettings = defaults()

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  const baseRecord = base as Record<string, unknown>
  const out: Record<string, unknown> = { ...baseRecord }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = baseRecord[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = deepMerge(current, value as DeepPartial<typeof current>)
    } else {
      out[key] = value
    }
  }
  return out as T
}

export const settingsRoutes: MockRouteMap = {
  settings_get: async () => state,
  settings_get_section: async (args) => {
    const { section } = args as { section: keyof MockSettings }
    if (!(section in state)) {
      throw new Error(`Unknown settings section: ${String(section)}`)
    }
    return state[section]
  },
  settings_update: async (args) => {
    const patch = args as DeepPartial<MockSettings>
    state = deepMerge(state, patch)
    return state
  },
  settings_reset: async () => {
    state = defaults()
    return state
  },

  // Domain-specific setter/getter the renderer's useGeneralSettings hook
  // calls. M1 smoke requires this to land the onboarding-completed flag
  // so FirstRunOnboarding can close. M2 replaces both routes with the
  // real settings KV commands.
  settings_get_general_settings: async () => state.general,
  settings_set_general_settings: async (args) => {
    const patch = (args ?? {}) as Partial<MockGeneralSettings>
    state = { ...state, general: { ...state.general, ...patch } }
    return { success: true }
  },

  // Calendar preferences — consumed by use-calendar-preferences
  settings_get_calendar_settings: async () => ({
    dayCellClickBehavior: 'journal' as const,
    calendarPageClickOverride: 'calendar' as const,
    defaultTargetCalendarId: null,
    onboardingCompleted: true,
    promoteConfirmDismissed: false
  }),
  settings_set_calendar_settings: async () => ({ success: true }),

  // Tab + startup settings
  settings_get_tab_settings: async () => ({}),
  settings_set_tab_settings: async () => ({ success: true }),

  // Journal settings
  settings_get_journal_settings: async () => ({}),
  settings_set_journal_settings: async () => ({ success: true }),

  // AI settings (separate from AI Inline below)
  settings_get_ai_settings: async () => ({ enabled: false }),
  settings_set_ai_settings: async () => ({ success: true })
}
