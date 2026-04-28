import { I18nextProvider } from 'react-i18next'
import type { ReactNode } from 'react'
import type { i18n as I18nInstance } from 'i18next'

interface I18nProviderProps {
  i18n: I18nInstance
  children: ReactNode
}

export function I18nProvider({ i18n, children }: I18nProviderProps): React.JSX.Element {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}
