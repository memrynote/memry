import { useT } from '@memry/i18n/renderer'

const K = 'onboardingWizard.agent'
const PRESETS = 'notes:tagFields.presets'

export function activityFieldKey(field: string): string {
  return `drawer.activityField${field}`
}

export const presetKeys = [`${PRESETS}.person.name`]

export function DynamicKeys({ id, local }: { id: string; local: boolean }): JSX.Element {
  const { t } = useT('common')
  return (
    <span>
      {t(`onboardingWizard.theme.${id}`)}
      {t(local ? `${K}.setUp` : `${K}.install`)}
      {t(`${K}.${id}`)}
    </span>
  )
}
