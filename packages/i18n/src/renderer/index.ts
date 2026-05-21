import i18next, { type i18n as I18nInstance } from 'i18next'
import { IcuFormatter } from '../shared/icu-formatter'
import { initReactI18next } from 'react-i18next'
import {
  type Locale,
  FALLBACK_LOCALE,
  I18N_NAMESPACES,
  DEFAULT_NAMESPACE,
  SUPPORTED_LOCALES
} from '../shared/config'
import { createLocaleBackend } from '../locales/load'

interface CreateRendererI18nOptions {
  locale: Locale
}

/**
 * Creates an i18next instance for the renderer process.
 *
 * Locale JSON is loaded through the i18next backend so startup only pulls
 * the active locale plus fallback resources.
 */
export async function createRendererI18n(
  options: CreateRendererI18nOptions
): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance
    .use(IcuFormatter)
    .use(createLocaleBackend())
    .use(initReactI18next)
    .init({
      lng: options.locale,
      fallbackLng: FALLBACK_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALES],
      ns: I18N_NAMESPACES,
      defaultNS: DEFAULT_NAMESPACE,
      interpolation: {
        escapeValue: false
      },
      react: {
        useSuspense: false
      }
    })
  return instance
}

export { I18nProvider } from './provider'
export { useT } from './use-t'
export { useDirection } from './use-direction'
export { applyLocaleToDocument } from './apply-document-attrs'
export type { I18nInstance }
