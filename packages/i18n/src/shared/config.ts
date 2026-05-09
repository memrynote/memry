/**
 * Locale configuration: display names and namespace registry.
 *
 * Locale identity (LocaleSchema, Locale type, SUPPORTED_LOCALES, FALLBACK_LOCALE)
 * is owned by @memry/contracts/locale-api. This file extends that with the
 * runtime/UI concerns: human-readable display names and the i18next namespace list.
 *
 * LOCALE_DISPLAY_NAMES are intentionally NOT translated — each language's
 * name is shown in its own native script so users can find their language
 * regardless of the current UI locale.
 */

import { type Locale } from '@memry/contracts/locale-api'

export {
  LocaleSchema,
  type Locale,
  SUPPORTED_LOCALES,
  FALLBACK_LOCALE
} from '@memry/contracts/locale-api'

export const LOCALE_DISPLAY_NAMES: Record<Locale, string> = {
  ar: 'العربية',
  cs: 'Čeština',
  da: 'Dansk',
  en: 'English',
  de: 'Deutsch',
  el: 'Ελληνικά',
  es: 'Español',
  fi: 'Suomi',
  fil: 'Filipino',
  fr: 'Français',
  he: 'עברית',
  hr: 'Hrvatski',
  hu: 'Magyar',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  ms: 'Bahasa Melayu',
  nl: 'Nederlands',
  no: 'Norsk',
  pl: 'Polski',
  pt: 'Português',
  ro: 'Română',
  ru: 'Русский',
  sk: 'Slovenčina',
  sv: 'Svenska',
  th: 'ไทย',
  tr: 'Türkçe',
  uk: 'Українська',
  vi: 'Tiếng Việt',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文'
}

export const I18N_NAMESPACES = [
  'common',
  'inbox',
  'notes',
  'journal',
  'calendar',
  'tasks',
  'graph',
  'settings',
  'errors',
  'menu',
  'system'
] as const

export type I18nNamespace = (typeof I18N_NAMESPACES)[number]

export const DEFAULT_NAMESPACE: I18nNamespace = 'common'
