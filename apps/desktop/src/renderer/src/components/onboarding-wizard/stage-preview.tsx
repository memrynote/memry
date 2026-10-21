import type { FeaturesSettings } from '@memry/contracts/settings-schemas'
import { useT } from '@memry/i18n/renderer'
import { ChevronDown, FileText, Search, Sparkles } from '@/lib/icons'
import {
  PageCalendarIcon,
  PageGraphIcon,
  PageHomeIcon,
  PageInboxIcon,
  PageJournalIcon,
  PageTasksIcon
} from '@/lib/icons/page-icons'
import { cn } from '@/lib/utils'
import { AgentPane } from './stage/agent-pane'
import { CalendarPane } from './stage/calendar-pane'
import { CanvasGlyph, CanvasPane } from './stage/canvas-pane'
import { GraphPane } from './stage/graph-pane'
import { HomePane } from './stage/home-pane'
import { InboxPane } from './stage/inbox-pane'
import { JournalPane } from './stage/journal-pane'
import { TasksPane } from './stage/tasks-pane'
import type { StageFocus, Translate } from './stage/types'

export type { StageFocus }

/** Same order as the real app's main nav; the agent icon follows when AI is on. */
const RAIL = [
  { key: 'home', icon: PageHomeIcon },
  { key: 'inbox', icon: PageInboxIcon },
  { key: 'journal', icon: PageJournalIcon },
  { key: 'calendar', icon: PageCalendarIcon },
  { key: 'tasks', icon: PageTasksIcon },
  { key: 'graph', icon: PageGraphIcon }
] as const

const TAB_ICON: Record<StageFocus, React.ComponentType<{ className?: string }>> = {
  home: PageHomeIcon,
  inbox: PageInboxIcon,
  journal: PageJournalIcon,
  calendar: PageCalendarIcon,
  tasks: PageTasksIcon,
  graph: PageGraphIcon,
  canvas: CanvasGlyph,
  agent: Sparkles
}

/**
 * A miniature, non-interactive Memry window under each step. It paints in the
 * live theme and drops the modules the user turned off, so choices show up
 * where they will land. The frame clips it at the window's bottom edge.
 */
export function StagePreview({
  features,
  aiEnabled,
  focus
}: {
  features: FeaturesSettings
  aiEnabled: boolean
  focus: StageFocus
}): React.JSX.Element {
  const { t, i18n } = useT('common')
  const p: Translate = (key, values) => t(`onboardingWizard.preview.${key}`, values)
  const rail = RAIL.filter((item) => features[item.key])
  const TabIcon = TAB_ICON[focus]
  const tabLabel =
    focus === 'agent'
      ? t('onboardingWizard.agent.section')
      : focus === 'canvas'
        ? p('canvasName')
        : t(`onboardingWizard.modules.${focus}`)
  const railItem = (selected: boolean): string =>
    cn(
      'flex size-7 items-center justify-center rounded-[7px] [&_svg]:size-3.5',
      selected && 'bg-sidebar-rail-active text-sidebar-rail-active-foreground'
    )
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none flex h-[420px] w-full max-w-[720px] shrink-0 select-none overflow-hidden rounded-lg border border-border bg-background shadow-[0_-24px_60px_-20px_rgb(0_0_0/0.35)] dark:shadow-[0_-24px_60px_-20px_rgb(0_0_0/0.6)]"
    >
      <div className="flex w-11 shrink-0 flex-col items-center gap-1 bg-sidebar-rail pt-[38px] text-sidebar-rail-foreground">
        {rail.map(({ key, icon: Icon }) => (
          <span key={key} className={railItem(key === focus)}>
            <Icon />
          </span>
        ))}
        {aiEnabled && (
          <span className={railItem(focus === 'agent')}>
            <Sparkles />
          </span>
        )}
      </div>
      <div className="flex w-44 shrink-0 flex-col gap-3.5 border-e border-border bg-sidebar px-2.5 pt-[34px] text-foreground">
        <div className="flex items-center justify-between px-1">
          <span className="flex items-center gap-1 text-xs font-semibold">
            {p('notesName')}
            <ChevronDown className="size-3 text-text-tertiary" />
          </span>
          <Search className="size-3 text-text-tertiary" />
        </div>
        <div className="flex h-[26px] items-center justify-between rounded-[7px] border border-border bg-surface px-2">
          <span className="text-[11.5px] font-medium">{p('newNote')}</span>
          <span className="font-mono text-[9.5px] text-text-tertiary">⌘N</span>
        </div>
        {focus === 'canvas' && (
          <PreviewSection title={p('canvases')}>
            <PreviewItem label={p('canvasName')} active>
              <CanvasGlyph className="size-3 text-foreground" />
            </PreviewItem>
          </PreviewSection>
        )}
        <PreviewSection title={p('collections')}>
          {[p('readingList'), p('ideas')].map((item) => (
            <PreviewItem key={item} label={item}>
              <FileText className="size-3 text-text-tertiary" />
            </PreviewItem>
          ))}
        </PreviewSection>
        <PreviewSection title={p('projects')}>
          <PreviewItem label={p('launch')}>
            <span className="size-[7px] rounded-full bg-indigo-400" />
          </PreviewItem>
          <PreviewItem label={p('fitness')}>
            <span className="size-[7px] rounded-full bg-green-400" />
          </PreviewItem>
        </PreviewSection>
      </div>
      <div className="flex min-w-0 grow flex-col">
        <div className="flex h-9 shrink-0 items-end border-b border-border px-2.5">
          <span className="flex h-9 items-center gap-1.5 border-b-2 border-tint px-2.5 text-[11.5px] font-medium text-foreground [&_svg]:size-3">
            <TabIcon />
            {tabLabel}
          </span>
        </div>
        <StagePane focus={focus} p={p} locale={i18n.resolvedLanguage ?? 'en'} name={tabLabel} />
      </div>
    </div>
  )
}

function PreviewSection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="px-1 pb-[3px] text-[9px] font-semibold uppercase leading-3 tracking-[0.07em] text-text-tertiary">
        {title}
      </span>
      {children}
    </div>
  )
}

function PreviewItem({
  label,
  active,
  children
}: {
  label: string
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex h-[22px] items-center gap-[7px] rounded-md px-1 text-[11.5px]',
        active && 'bg-sidebar-surface'
      )}
    >
      {children}
      <span className="truncate">{label}</span>
    </span>
  )
}

function StagePane({
  focus,
  p,
  locale,
  name
}: {
  focus: StageFocus
  p: Translate
  locale: string
  name: string
}): React.JSX.Element {
  switch (focus) {
    case 'home':
      return <HomePane p={p} name={name} />
    case 'inbox':
      return <InboxPane p={p} name={name} />
    case 'journal':
      return <JournalPane p={p} />
    case 'calendar':
      return <CalendarPane p={p} locale={locale} />
    case 'tasks':
      return <TasksPane p={p} />
    case 'graph':
      return <GraphPane p={p} />
    case 'canvas':
      return <CanvasPane p={p} />
    case 'agent':
      return <AgentPane p={p} />
  }
}
