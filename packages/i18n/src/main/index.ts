import i18next, { type i18n as I18nInstance } from 'i18next'
import { IcuFormatter } from '../shared/icu-formatter'
import {
  type Locale,
  FALLBACK_LOCALE,
  I18N_NAMESPACES,
  DEFAULT_NAMESPACE,
  SUPPORTED_LOCALES
} from '../shared/config'
import { createLocaleBackend } from '../locales/load'
import { EN_BUNDLE } from '../locales/en-bundle'

interface CreateMainI18nOptions {
  locale: Locale
}

/**
 * Creates an i18next instance for the Electron main process.
 *
 * Locale JSON is loaded through the i18next backend before this factory
 * resolves, so menu construction still sees a fully initialized instance.
 */
export async function createMainI18n(options: CreateMainI18nOptions): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance
    .use(IcuFormatter)
    .use(createLocaleBackend())
    .init({
      lng: options.locale,
      fallbackLng: FALLBACK_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALES],
      ns: I18N_NAMESPACES,
      defaultNS: DEFAULT_NAMESPACE,
      interpolation: {
        escapeValue: false // main process renders no HTML
      },
      appendNamespaceToMissingKey: true,
      initImmediate: false // synchronous init
    })
  return instance
}

/**
 * A synchronous English-only instance.
 *
 * The main process answers IPC calls that can, in principle, run before boot has
 * installed the real instance. Without this, such a call would surface an
 * initialization error where the user expects an error message, so this is the
 * last resort behind `getMainI18n()` rather than a second translation path.
 * Resources are inlined (no backend, no await) precisely so it cannot fail.
 */
export function createEnglishFallbackI18n(): I18nInstance {
  const instance = i18next.createInstance()
  void instance.use(IcuFormatter).init({
    lng: FALLBACK_LOCALE,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [FALLBACK_LOCALE],
    ns: I18N_NAMESPACES,
    defaultNS: DEFAULT_NAMESPACE,
    resources: { [FALLBACK_LOCALE]: EN_BUNDLE },
    interpolation: { escapeValue: false },
    appendNamespaceToMissingKey: true,
    initImmediate: false
  })
  return instance
}

export type { I18nInstance }
