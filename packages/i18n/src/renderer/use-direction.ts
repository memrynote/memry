import { useTranslation } from 'react-i18next'
import { localeDirection } from '../shared/direction'

/**
 * React hook returning the active locale's document direction.
 */
export function useDirection(): 'ltr' | 'rtl' {
  const { i18n } = useTranslation()
  return localeDirection(i18n.language)
}
