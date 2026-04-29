import { useT } from '@memry/i18n/renderer'

export function MissingKey() {
  const { t } = useT('notes')
  return <p>{t('missing.phaseEKey')}</p>
}
