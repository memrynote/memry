import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { AlternativesRail } from './alternatives-rail'
import { LabRail } from './lab-rail'
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
  /** Lab needs AI; its tab is not rendered without it. */
  aiEnabled: boolean
}

/** The note side rail in one of its writing modes (review cards are the default mode). */
export function WritingRail({ mode, session, snapshot, aiEnabled }: WritingRailProps) {
  return (
    <div className="flex flex-col gap-2">
      <WritingRailTabs
        mode={mode}
        aiEnabled={aiEnabled}
        alternativeCount={snapshot.alternatives.length}
        overflowCount={snapshot.overflow.length}
        onSelect={(next) => session.setMode(next)}
      />
      <WritingRailBody mode={mode} session={session} snapshot={snapshot} />
    </div>
  )
}

interface WritingRailTabsProps {
  mode: WritingRailMode
  aiEnabled: boolean
  alternativeCount: number
  overflowCount: number
  onSelect: (mode: WritingRailMode) => void
}

function WritingRailTabs({
  mode,
  aiEnabled,
  alternativeCount,
  overflowCount,
  onSelect
}: WritingRailTabsProps) {
  const { t } = useT('notes')
  const tabs: Array<{ mode: WritingRailMode; label: string; count?: number }> = [
    { mode: 'alternatives', label: t('writingTools.chrome.alternatives'), count: alternativeCount },
    { mode: 'overflow', label: t('writingTools.chrome.overflow'), count: overflowCount },
    ...(aiEnabled ? [{ mode: 'lab' as const, label: t('writingTools.chrome.lab') }] : [])
  ]
  return (
    <div
      role="tablist"
      aria-label={t('writingTools.chrome.menu')}
      data-testid="writing-rail-tabs"
      className="flex w-[308px] items-center gap-0.5 rounded-lg bg-surface p-0.5"
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
  )
}

function WritingRailBody({ mode, session, snapshot }: Omit<WritingRailProps, 'aiEnabled'>) {
  switch (mode) {
    case 'alternatives':
      return <AlternativesRail session={session} snapshot={snapshot} />
    case 'overflow':
      return <OverflowRail session={session} snapshot={snapshot} />
    case 'lab':
      return <LabRail session={session} snapshot={snapshot} />
  }
}
