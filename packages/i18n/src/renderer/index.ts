import i18next, { type i18n as I18nInstance } from 'i18next'
import ICU from 'i18next-icu'
import { initReactI18next } from 'react-i18next'
import {
  type Locale,
  FALLBACK_LOCALE,
  I18N_NAMESPACES,
  DEFAULT_NAMESPACE
} from '../shared/config'
import { RESOURCES } from '../locales'

interface CreateRendererI18nOptions {
  locale: Locale
}

/**
 * Creates an i18next instance for the renderer process.
 *
 * Resources are bundled eagerly into the renderer JS bundle. For Phase A,
 * the string set is intentionally tiny; this can move to lazy namespace
 * loading when translation volume grows.
 */
export async function createRendererI18n(
  options: CreateRendererI18nOptions
): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng: options.locale,
      fallbackLng: FALLBACK_LOCALE,
      ns: I18N_NAMESPACES,
      defaultNS: DEFAULT_NAMESPACE,
      resources: RESOURCES,
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
export type { I18nInstance }
