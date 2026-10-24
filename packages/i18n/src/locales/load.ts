import resourcesToBackend from 'i18next-resources-to-backend'
import {
  type Locale,
  FALLBACK_LOCALE,
  I18N_NAMESPACES,
  LocaleSchema,
  type I18nNamespace
} from '../shared/config'

export type NamespaceResource = Record<string, unknown>
export type LocaleResources = Record<I18nNamespace, NamespaceResource>

function parseLocale(language: string): Locale | null {
  const result = LocaleSchema.safeParse(language)
  return result.success ? result.data : null
}

function parseNamespace(namespace: string): I18nNamespace | null {
  return I18N_NAMESPACES.find((known) => known === namespace) ?? null
}

export async function loadLocaleNamespace(
  locale: Locale,
  namespace: I18nNamespace
): Promise<NamespaceResource> {
  const module = await import(`./${locale}/${namespace}.json`)
  const resource: NamespaceResource = module.default
  return resource
}

export async function loadLocaleResources(locale: Locale): Promise<LocaleResources> {
  const namespaces = await Promise.all(
    I18N_NAMESPACES.map(async (namespace) => {
      const resource = await loadLocaleNamespace(locale, namespace)
      return [namespace, resource] as const
    })
  )

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries widens to a string-keyed record; the entries cover every I18N_NAMESPACES member
  return Object.fromEntries(namespaces) as LocaleResources
}

export function createLocaleBackend() {
  return resourcesToBackend(async (language: string, namespace: string) => {
    const locale = parseLocale(language) ?? FALLBACK_LOCALE
    const parsedNamespace = parseNamespace(namespace)
    if (!parsedNamespace) return null

    return loadLocaleNamespace(locale, parsedNamespace)
  })
}
