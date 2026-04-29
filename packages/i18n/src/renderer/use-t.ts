import { useTranslation } from 'react-i18next'
import type { I18nNamespace } from '../shared/config'

/**
 * Strongly-typed translation hook bound to a specific namespace.
 */
export function useT(namespace: I18nNamespace) {
  return useTranslation(namespace)
}
