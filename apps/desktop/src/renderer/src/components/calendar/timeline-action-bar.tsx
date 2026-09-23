import { forwardRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import { altKey, modifierKey } from '@/hooks/use-keyboard-shortcuts'
import { cn } from '@/lib/utils'
import { Keycaps } from './timeline-action-panel'

function Hint({ label, keys }: { label: string; keys: string[] }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs text-text-secondary">{label}</span>
      <Keycaps keys={keys} />
    </span>
  )
}

function Divider(): React.JSX.Element {
  return <span aria-hidden="true" className="h-3.5 w-px bg-border" />
}

interface TimelineActionBarProps {
  /** Selected row, or null for the idle hints. */
  selection: { title: string; detail: string; color: string; kind: 'task' | 'event' } | null
  summary: string
  /** Rendered as the Actions trigger; wraps the ⌘K hint. */
  renderActionsTrigger: (trigger: React.ReactNode) => React.ReactNode
}

const ActionsButton = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<'button'>>(
  function ActionsButton({ className, ...props }, ref) {
    const { t } = useT('calendar')
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          '-me-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors duration-100',
          'hover:bg-surface-active/70 focus-visible:outline-2 focus-visible:outline-ring',
          className
        )}
        {...props}
      >
        <span className="text-xs text-text-secondary">{t('timeline.bar.actions')}</span>
        <Keycaps keys={[modifierKey, 'K']} />
      </button>
    )
  }
)

/**
 * Raycast-style footer: what is selected on the left, the keys that act on it
 * on the right.
 */
export function TimelineActionBar({
  selection,
  summary,
  renderActionsTrigger
}: TimelineActionBarProps): React.JSX.Element {
  const { t } = useT('calendar')

  return (
    <div
      data-testid="timeline-action-bar"
      className="flex h-10 shrink-0 items-center justify-between gap-4 border-t border-border/70 bg-foreground/[0.02] ps-6 pe-4"
    >
      <div className="flex min-w-0 items-center gap-2" aria-live="polite">
        {selection ? (
          <>
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: selection.color }}
            />
            <span className="truncate text-xs font-medium text-foreground">{selection.title}</span>
            <span className="shrink-0 text-xs text-text-tertiary tabular-nums">
              {selection.detail}
            </span>
          </>
        ) : (
          <span className="truncate text-xs text-text-tertiary">{summary}</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3.5">
        {selection?.kind === 'task' ? (
          <>
            <span className="hidden items-center gap-3.5 @2xl:flex">
              <Hint label={t('timeline.bar.open')} keys={['↵']} />
              <Divider />
              <Hint label={t('timeline.bar.move')} keys={['⇧', '←', '→']} />
              <Divider />
              <Hint label={t('timeline.bar.resize')} keys={[altKey, '←', '→']} />
              <Divider />
            </span>
            {renderActionsTrigger(<ActionsButton />)}
          </>
        ) : (
          <span className="hidden items-center gap-3.5 @2xl:flex">
            {selection?.kind === 'event' ? (
              <Hint label={t('timeline.bar.open')} keys={['↵']} />
            ) : (
              <>
                <Hint label={t('timeline.bar.select')} keys={['↑', '↓']} />
                <Divider />
                <Hint label={t('timeline.bar.today')} keys={['T']} />
              </>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
