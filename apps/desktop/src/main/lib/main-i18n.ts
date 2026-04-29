import type { I18nInstance } from '@memry/i18n/main'

let active: I18nInstance | null = null

export function setMainI18n(instance: I18nInstance): void {
  active = instance
}

export function getMainI18n(): I18nInstance {
  if (!active) {
    throw new Error('main-process i18n not initialized — call setMainI18n during boot')
  }
  return active
}

export function __resetMainI18nForTest(): void {
  active = null
}
