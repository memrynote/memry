import type React from 'react'
import { useJournalStreak } from '@/hooks/use-journal-streak'
import { Flame } from '@/lib/icons/icon-map'
import { useT } from '@memry/i18n/renderer'

// Rendered in the WidgetFrame `HeaderFilter` slot (right after the title), matching the
// design's streak pill position. Display-only — ignores config/onChange.
export function JournalHeaderStreak(): React.JSX.Element | null {
  const { t } = useT('common')
  const { streak, isLoading } = useJournalStreak()
  const count = streak?.currentStreak ?? 0

  if (isLoading || count === 0) return null

  return (
    <span className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border border-[var(--tint-border)] bg-[var(--tint-light)] px-2 text-[11px] font-semibold text-[var(--tint)]">
      <Flame className="size-3" aria-hidden="true" />
      <span className="truncate">{t('home.widget.journalStreak', { count })}</span>
    </span>
  )
}
