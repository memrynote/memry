import { useT } from '@memry/i18n/renderer'
import type { FoldLevel } from '@memry/contracts/note-fold'

interface FoldPillProps {
  level: Exclude<FoldLevel, 'full'>
  agent: string | null
  sectionCount: number
  openCount: number
  onFull: () => void
}

/** Bottom pill: which level shows, who wrote it from Key down, and how to leave. */
export function FoldPill({ level, agent, sectionCount, openCount, onFull }: FoldPillProps) {
  const { t } = useT('notes')
  const description = t(`fold.pill.description.${level}`, {
    agent: agent ?? t('fold.chrome.unknownAgent'),
    count: sectionCount
  })
  return (
    <div className="pointer-events-none sticky bottom-7 z-10 mt-auto flex justify-center pt-6">
      <div
        role="status"
        aria-label={t('fold.pill.aria')}
        className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-border bg-background px-3 py-[7px] text-xs leading-4 shadow-[0_4px_14px_rgba(29,31,34,0.08)]"
      >
        <span className="font-medium text-foreground">{t(`fold.level.${level}`)}</span>
        <span className="text-text-secondary">
          {openCount > 0
            ? `${description} · ${t('fold.pill.opened', { count: openCount })}`
            : description}
        </span>
        <span aria-hidden className="h-3.5 w-px bg-border" />
        <button
          type="button"
          onClick={onFull}
          className="flex items-center gap-2.5 rounded-sm text-text-secondary outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <kbd className="rounded-sm border border-border px-1.5 py-px font-mono text-[11px] leading-3.5">
            {t('fold.pill.escape')}
          </kbd>
          <span>{t('fold.pill.fullText')}</span>
        </button>
      </div>
    </div>
  )
}
