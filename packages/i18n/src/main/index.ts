import i18next, { type i18n as I18nInstance } from 'i18next'
import { IcuFormatter } from '../shared/icu-formatter'
import {
  type Locale,
  FALLBACK_LOCALE,
  I18N_NAMESPACES,
  DEFAULT_NAMESPACE
} from '../shared/config'
import { RESOURCES } from '../locales'

interface CreateMainI18nOptions {
  locale: Locale
}

/**
 * Creates an i18next instance for the Electron main process.
 *
 * Synchronous resource loading: all namespaces for all SUPPORTED_LOCALES
 * are bundled into the main-process JS bundle via the static RESOURCES
 * import. No filesystem I/O, no async race with menu construction.
 */
export async function createMainI18n(
  options: CreateMainI18nOptions
): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance.use(IcuFormatter).init({
    lng: options.locale,
    fallbackLng: FALLBACK_LOCALE,
    ns: I18N_NAMESPACES,
    defaultNS: DEFAULT_NAMESPACE,
    resources: RESOURCES,
    interpolation: {
      escapeValue: false // main process renders no HTML
    },
    appendNamespaceToMissingKey: true,
    initImmediate: false // synchronous init
  })
  return instance
}

export type { I18nInstance }
