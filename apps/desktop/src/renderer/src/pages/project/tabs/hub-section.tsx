import { useT } from '@memry/i18n/renderer'
import { Plus } from '@/lib/icons'

interface HubSectionProps {
  title: string
  count: number
  /** Omitted on the full tabs, where "view all" would point at the current tab. */
  onViewAll?: () => void
  onAdd: () => void
  emptyLabel: string
  children: React.ReactNode
  /** True when the section has no rows — renders the empty line instead. */
  isEmpty: boolean
}

/**
 * Section chrome shared by the overview previews and the full tabs: heading,
 * count, "view all", "+", then the rows.
 *
 * Unlike the sections this replaces, an empty category still renders. The hub
 * should show what a project can hold, not silently omit it.
 */
export const HubSection = ({
  title,
  count,
  onViewAll,
  onAdd,
  emptyLabel,
  children,
  isEmpty
}: HubSectionProps): React.JSX.Element => {
  const { t } = useT('tasks')

  return (
    <section className="px-4 py-3">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>

        <div className="ms-auto flex items-center gap-1">
          {onViewAll ? (
            <button
              type="button"
              onClick={onViewAll}
              className="rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('projectHub.sections.viewAll')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onAdd}
            aria-label={t('projectHub.sections.add', { title })}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {isEmpty ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="space-y-0.5">{children}</ul>
      )}
    </section>
  )
}
