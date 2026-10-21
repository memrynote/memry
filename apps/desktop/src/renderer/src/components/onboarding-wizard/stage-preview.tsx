import type { FeaturesSettings } from '@memry/contracts/settings-schemas'
import { useT } from '@memry/i18n/renderer'
import { Check, ChevronDown, FileText, Search, Sparkles } from '@/lib/icons'
import {
  PageCalendarIcon,
  PageGraphIcon,
  PageHomeIcon,
  PageInboxIcon,
  PageJournalIcon,
  PageTasksIcon
} from '@/lib/icons/page-icons'
import { cn } from '@/lib/utils'

export type StageFocus = 'journal' | 'tasks' | 'agent' | 'home'

type Translate = (key: string) => string

const RAIL = [
  { key: 'home', icon: PageHomeIcon },
  { key: 'inbox', icon: PageInboxIcon },
  { key: 'journal', icon: PageJournalIcon },
  { key: 'calendar', icon: PageCalendarIcon },
  { key: 'tasks', icon: PageTasksIcon },
  { key: 'graph', icon: PageGraphIcon }
] as const

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
  const { t } = useT('common')
  const p: Translate = (key) => t(`onboardingWizard.preview.${key}`)
  const rail = RAIL.filter((item) => features[item.key])
  const tab =
    focus === 'agent'
      ? { icon: <Sparkles />, label: t('onboardingWizard.agent.section') }
      : focus === 'tasks'
        ? { icon: <PageTasksIcon />, label: t('onboardingWizard.modules.tasks') }
        : { icon: <PageJournalIcon />, label: p('today') }
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none flex h-[420px] w-full max-w-[720px] shrink-0 select-none overflow-hidden rounded-lg border border-border bg-background shadow-[0_-24px_60px_-20px_rgb(0_0_0/0.35)] dark:shadow-[0_-24px_60px_-20px_rgb(0_0_0/0.6)]"
    >
      <div className="flex w-11 shrink-0 flex-col items-center gap-1.5 bg-sidebar-rail pt-[38px] text-sidebar-rail-foreground">
        {rail.map(({ key, icon: Icon }) => (
          <span
            key={key}
            className={cn(
              'flex size-7 items-center justify-center rounded-[7px] [&_svg]:size-3.5',
              key === focus && 'bg-surface-active text-foreground'
            )}
          >
            <Icon />
          </span>
        ))}
        {aiEnabled && (
          <span
            className={cn(
              'flex size-7 items-center justify-center rounded-[7px] [&_svg]:size-3.5',
              focus === 'agent' && 'bg-surface-active text-foreground'
            )}
          >
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
            {tab.icon}
            {tab.label}
          </span>
        </div>
        {focus === 'agent' ? (
          <AgentPane p={p} />
        ) : focus === 'tasks' ? (
          <TasksPane p={p} />
        ) : (
          <JournalPane p={p} />
        )}
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
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex h-[22px] items-center gap-[7px] px-1 text-[11.5px]">
      {children}
      <span className="truncate">{label}</span>
    </span>
  )
}

function JournalPane({ p }: { p: Translate }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 px-[30px] pt-[26px]">
      <span className="text-[9px] font-semibold uppercase leading-3 tracking-[0.08em] text-text-tertiary">
        {p('weekday')}
      </span>
      <span className="font-serif text-[32px] font-medium leading-9 tracking-[-0.01em] text-foreground">
        {p('date')}
      </span>
      <span className="max-w-[300px] pt-2.5 text-xs leading-[19px] text-foreground">
        {p('journalLine')}
      </span>
      <div className="flex flex-col gap-0.5 pt-2 text-xs">
        {[p('task1'), p('task2'), p('task3')].map((task, index) => (
          <span key={task} className="flex h-[21px] items-center gap-2">
            {index === 0 ? (
              <span className="flex size-3 items-center justify-center rounded-[3px] bg-foreground text-background">
                <Check className="size-2.5" />
              </span>
            ) : (
              <span className="size-3 rounded-[3px] border-[1.25px] border-text-tertiary" />
            )}
            <span
              className={cn(index === 0 ? 'text-text-tertiary line-through' : 'text-foreground')}
            >
              {task}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Quick add with parsed tokens, then today's list: what the tasks module looks like. */
function TasksPane({ p }: { p: Translate }): React.JSX.Element {
  const token = (text: string, color: string): React.JSX.Element => (
    <span
      className="flex h-5 items-center rounded-[5px] px-1.5 text-[11.5px] font-medium"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)` }}
    >
      {text}
    </span>
  )
  return (
    <div className="flex flex-col gap-4 px-[22px] pt-[18px] text-foreground">
      <div className="flex h-9 items-center gap-[5px] rounded-md bg-surface px-2.5 ring-1 ring-text-tertiary">
        <span className="text-[12.5px]">{p('task3')}</span>
        {token(p('tokenDate'), 'var(--task-token-date)')}
        {token(p('tokenPriority'), 'var(--task-priority-high)')}
        {token(p('tokenTag'), 'var(--task-token-tag)')}
        <span className="h-4 w-px bg-foreground" />
      </div>
      <div className="flex flex-col">
        <span className="flex items-center gap-1.5 px-1 pb-1">
          <span className="text-xs font-semibold">{p('today')}</span>
          <span className="text-[11px] text-text-tertiary">2</span>
        </span>
        {[
          { label: p('task2'), meta: p('launch'), dot: true },
          { label: p('task4'), meta: p('today'), dot: false }
        ].map((row) => (
          <span key={row.label} className="flex h-[26px] items-center gap-[9px] px-1">
            <span className="size-3 shrink-0 rounded-sm border-[1.25px] border-text-tertiary" />
            <span className="grow text-xs">{row.label}</span>
            <span className="flex items-center gap-[5px] text-[11px] text-text-tertiary">
              {row.dot && <span className="size-1.5 rounded-full bg-indigo-400" />}
              {row.meta}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

function AgentPane({ p }: { p: Translate }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-4 px-8 pt-16">
      <span className="font-serif text-[26px] font-medium text-foreground">{p('agentPrompt')}</span>
      <span className="flex h-[72px] w-full max-w-[380px] items-start rounded-2xl border border-border px-3 pt-2.5 text-[11.5px] text-text-tertiary">
        {p('agentPlaceholder')}
      </span>
    </div>
  )
}
