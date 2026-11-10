import fs from 'node:fs/promises'

import {
  FALLBACK_LOCALE,
  LocaleSchema,
  SUPPORTED_LOCALES,
  type Locale
} from '@memry/contracts/locale-api'

import { getConfigPath, getMemryDir, readVaultConfig } from './paths.ts'
import { writeFileAtomic } from './write-file-atomic.ts'
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
  /**
   * The config with `preferences.language` set. Refuses an unreadable config.json before
   * anything changes: rewriting it would lose the user's settings.
   */
  async function withPortablePreference(locale: Locale): Promise<Record<string, unknown>> {
    const stored = await readVaultConfig(getConfigPath(vaultPath))
    if (stored.kind === 'unreadable') {
      throw new Error(`${stored.reason}; the locale is not changed. Fix the file and retry.`)
    }
    const config = stored.value
    const preferences =
      config.preferences &&
      typeof config.preferences === 'object' &&
      !Array.isArray(config.preferences)
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
          (config.preferences as Record<string, unknown>)
        : {}
    return { ...config, preferences: { ...preferences, language: locale } }
  }

  return {
    async get() {
      const general = await settings.getGroup('general')
      const parsed = LocaleSchema.safeParse(general.language)
      return parsed.success ? parsed.data : FALLBACK_LOCALE
    },

    async set(candidate) {
      const locale = LocaleSchema.parse(candidate)
      const config = await withPortablePreference(locale)
      await settings.setGroup('general', { language: locale })
      await fs.mkdir(getMemryDir(vaultPath), { recursive: true })
      await writeFileAtomic(getConfigPath(vaultPath), `${JSON.stringify(config, null, 2)}\n`)
      return { locale }
    },

    async list() {
      return SUPPORTED_LOCALES
    }
  }
}
