import { useT } from '@memry/i18n/renderer'
import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { AlternativesRail } from './alternatives-rail'
import { OverflowRail } from './overflow-rail'
import type {
  WritingRailMode,
  WritingToolsSession,
  WritingToolsSnapshot
} from './writing-tools-session'

interface WritingRailProps {
  mode: WritingRailMode
  session: WritingToolsSession
  snapshot: WritingToolsSnapshot
}

/** The note side rail in one of its writing modes (review cards are the default mode). */
export function WritingRail({ mode, session, snapshot }: WritingRailProps) {
  return (
    <div className="flex flex-col gap-2">
      <WritingRailTabs
        mode={mode}
        alternativeCount={snapshot.alternatives.length}
        overflowCount={snapshot.overflow.length}
        onSelect={(next) => session.setMode(next)}
        onClose={() => session.setMode(null)}
      />
      <WritingRailBody mode={mode} session={session} snapshot={snapshot} />
    </div>
  )
}

interface WritingRailTabsProps {
  mode: WritingRailMode
  alternativeCount: number
  overflowCount: number
  onSelect: (mode: WritingRailMode) => void
  onClose: () => void
}

function WritingRailTabs({
  mode,
  alternativeCount,
  overflowCount,
  onSelect,
  onClose
}: WritingRailTabsProps) {
  const { t } = useT('notes')
  const tabs: Array<{ mode: WritingRailMode; label: string; count?: number }> = [
    { mode: 'alternatives', label: t('writingTools.chrome.alternatives'), count: alternativeCount },
    { mode: 'overflow', label: t('writingTools.chrome.overflow'), count: overflowCount }
  ]
  const closeLabel = t('writingTools.chrome.close')
  return (
    <div className="flex w-[308px] items-center gap-1">
      <div
        role="tablist"
        aria-label={t('writingTools.chrome.menu')}
        data-testid="writing-rail-tabs"
        className="flex min-w-0 flex-1 items-center gap-0.5 rounded-lg bg-surface p-0.5"
      >
        {tabs.map((tab) => {
          const selected = tab.mode === mode
          return (
            <button
              key={tab.mode}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(tab.mode)}
              className={cn(
                'flex h-[26px] flex-1 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                selected
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-text-secondary hover:text-foreground'
              )}
            >
              {tab.label}
              {tab.count ? (
                <span className="tabular-nums text-text-tertiary">{tab.count}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        title={closeLabel}
        data-testid="writing-rail-close"
        className="flex size-[30px] shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-active hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function WritingRailBody({ mode, session, snapshot }: WritingRailProps) {
  switch (mode) {
    case 'alternatives':
      return <AlternativesRail session={session} snapshot={snapshot} />
    case 'overflow':
      return <OverflowRail session={session} snapshot={snapshot} />
  }
}
