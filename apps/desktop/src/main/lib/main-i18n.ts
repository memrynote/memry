import { createEnglishFallbackI18n, type I18nInstance } from '@memry/i18n/main'
import { createLogger } from './logger'

const log = createLogger('MainI18n')

let active: I18nInstance | null = null
let fallback: I18nInstance | null = null

export function setMainI18n(instance: I18nInstance): void {
  active = instance
}

/**
 * The main-process translator.
 *
 * Before boot installs the real instance this returns an English-only one
 * instead of throwing. Main-process translations are mostly IPC error copy, and
 * throwing here would replace the message the user is supposed to read with an
 * internal initialization error — a worse failure than showing English. The
 * boot-order problem is still reported, just to the log rather than to the user.
 */
export function getMainI18n(): I18nInstance {
  if (active) return active

  if (!fallback) {
    log.error(
      'main-process i18n not initialized — falling back to English; setMainI18n runs during boot'
    )
    fallback = createEnglishFallbackI18n()
  }
  return fallback
}

export function isMainI18nInitialized(): boolean {
  return active !== null
}

export function __resetMainI18nForTest(): void {
  active = null
  fallback = null
}
