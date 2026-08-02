import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useRelativeTime } from './use-relative-time'

interface RailDetailsProps {
  createdAt: Date | null
  modifiedAt: Date | null
  counts: { notes: number; files: number; events: number }
}

export const RailDetails = ({
  createdAt,
  modifiedAt,
  counts
}: RailDetailsProps): React.JSX.Element => {
  const { t, i18n } = useT('tasks')

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric', year: 'numeric' }),
    [i18n.language]
  )

  const updated = useRelativeTime(modifiedAt ? modifiedAt.toISOString() : null, i18n.language)

  return (
    <section className="px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('projectHub.rail.details')}
      </h3>

      <dl className="space-y-1.5 text-sm">
        {createdAt ? (
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-muted-foreground">{t('projectHub.rail.created')}</dt>
            <dd className="min-w-0 text-foreground">{dateFormatter.format(createdAt)}</dd>
          </div>
        ) : null}

        {updated ? (
          <div className="flex gap-3">
            <dt className="w-20 shrink-0 text-muted-foreground">{t('projectHub.rail.updated')}</dt>
            <dd className="min-w-0 text-foreground">{updated}</dd>
          </div>
        ) : null}

        <div className="flex gap-3">
          <dt className="w-20 shrink-0 text-muted-foreground">{t('projectHub.rail.linked')}</dt>
          <dd className="min-w-0 text-foreground">
            {t('projectHub.rail.linkedSummary', {
              notes: counts.notes,
              files: counts.files,
              events: counts.events
            })}
          </dd>
        </div>
      </dl>
    </section>
  )
}
