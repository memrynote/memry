import fs from 'node:fs/promises'

import {
  FALLBACK_LOCALE,
  LocaleSchema,
  SUPPORTED_LOCALES,
  type Locale
} from '@memry/contracts/locale-api'

import { getConfigPath, getMemryDir } from './paths.ts'
import type { SettingsService } from '@memry/app-core/settings'

export interface LocaleService {
  get(): Promise<Locale>
  set(locale: string): Promise<{ locale: Locale }>
  list(): Promise<readonly Locale[]>
}

export function createLocaleService({
  vaultPath,
  settings
}: {
  vaultPath: string
  settings: SettingsService
}): LocaleService {
  async function writePortablePreference(locale: Locale): Promise<void> {
    const configPath = getConfigPath(vaultPath)
    let config: Record<string, unknown> = {}
    try {
      config = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>
    } catch {
      config = {}
    }

    const preferences =
      config.preferences &&
      typeof config.preferences === 'object' &&
      !Array.isArray(config.preferences)
        ? (config.preferences as Record<string, unknown>)
        : {}

    await fs.mkdir(getMemryDir(vaultPath), { recursive: true })
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ ...config, preferences: { ...preferences, language: locale } }, null, 2)}\n`,
      'utf-8'
    )
  }

  return {
    async get() {
      const general = await settings.getGroup('general')
      const parsed = LocaleSchema.safeParse(general.language)
      return parsed.success ? parsed.data : FALLBACK_LOCALE
    },

    async set(candidate) {
      const locale = LocaleSchema.parse(candidate)
      await settings.setGroup('general', { language: locale })
      await writePortablePreference(locale)
      return { locale }
    },

    async list() {
      return SUPPORTED_LOCALES
    }
  }
}
