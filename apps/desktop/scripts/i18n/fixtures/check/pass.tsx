import { useT } from '@memry/i18n/renderer'

export function PassingComponent({ noteTitle }: { noteTitle: string }) {
  const { t } = useT('notes')
  return (
    <section aria-label={t('tree.aria.tree')}>
      <h1>{t('page.empty.title')}</h1>
      <span>{noteTitle}</span>
    </section>
  )
}
