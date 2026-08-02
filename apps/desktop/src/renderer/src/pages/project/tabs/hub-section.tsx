import { useT } from '@memry/i18n/renderer'
import { Plus } from '@/lib/icons'

interface HubSectionHeaderProps {
  title: string
  count: number
  /** Omitted on the full tabs, where "view all" would point at the current tab. */
  onViewAll?: () => void
  onAdd: () => void
}

/**
 * Category heading — "Notes 12" plus its "view all" and "+".
 *
 * Typography is the Inbox section header's (`InboxListSection`): a quiet
 * small-caps-weight label rather than a page-title-sized one, so the items
 * themselves stay the loudest thing on the page.
 */
export const HubSectionHeader = ({
  title,
  count,
  onViewAll,
  onAdd
}: HubSectionHeaderProps): React.JSX.Element => {
  const { t } = useT('tasks')

  return (
    <div className="mb-1 flex items-center gap-1.5 px-2 py-2">
      <h2 className="text-xs font-semibold tracking-[0.02em] text-muted-foreground">{title}</h2>
      <span className="text-[11px] leading-[14px] tabular-nums text-muted-foreground/50">
        {count}
      </span>

      <div className="ms-auto flex items-center gap-1">
        {onViewAll ? (
          <button
            type="button"
            onClick={onViewAll}
            className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            {t('projectHub.sections.viewAll')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onAdd}
          aria-label={t('projectHub.sections.add', { title })}
          className="rounded-sm p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

interface HubSectionProps extends HubSectionHeaderProps {
  emptyLabel: string
  children: React.ReactNode
  /** True when the section has no rows — renders the empty line instead. */
  isEmpty: boolean
}

/**
 * A category and its rows, used by the overview previews.
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
}: HubSectionProps): React.JSX.Element => (
  <section className="px-4 py-3">
    <HubSectionHeader title={title} count={count} onViewAll={onViewAll} onAdd={onAdd} />

    {isEmpty ? (
      <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{emptyLabel}</p>
    ) : (
      <div role="list" className="space-y-px">
        {children}
      </div>
    )}
  </section>
)
