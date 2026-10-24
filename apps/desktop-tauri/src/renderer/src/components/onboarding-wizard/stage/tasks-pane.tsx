import { Flag } from '@/lib/icons'
import { TaskCircle, tint } from './parts'
import type { Translate } from './types'

function Token({ color, children }: { color: string; children: string }): React.JSX.Element {
  return (
    <span
      className="flex h-5 items-center rounded-[5px] px-1.5 text-[11.5px] font-medium"
      style={{ color, ...tint(color, 18) }}
    >
      {children}
    </span>
  )
}

function SectionTitle({
  title,
  count,
  color
}: {
  title: string
  count: number
  color: string
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5 px-1 pb-1">
      <span className="h-3 w-[3px] rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-xs font-semibold leading-4">{title}</span>
      <span className="text-[11px] text-text-tertiary">{count}</span>
    </span>
  )
}

function Row({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="flex h-7 items-center gap-[9px] px-1 text-xs">
      <TaskCircle />
      <span className="grow basis-0 truncate leading-4">{title}</span>
      {children}
    </span>
  )
}

function DueToday({ label }: { label: string }): React.JSX.Element {
  return (
    <span
      className="flex h-[18px] items-center rounded-[5px] border px-1.5 text-[10.5px]"
      style={{
        color: 'var(--task-due-today)',
        borderColor: 'color-mix(in srgb, var(--task-due-today) 45%, transparent)'
      }}
    >
      {label}
    </span>
  )
}

function Project({ label, className }: { label: string; className: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-[5px] text-[11px] text-text-tertiary">
      <span className={`size-[7px] rounded-[2px] ${className}`} />
      {label}
    </span>
  )
}

/** Quick add with parsed tokens, then the day's lists. */
export function TasksPane({ p }: { p: Translate }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3.5 px-[22px] pt-4 text-foreground">
      <div className="flex h-9 items-center gap-[5px] rounded-lg bg-surface px-2.5 ring-1 ring-text-tertiary/60">
        <span className="text-[12.5px]">{p('task3')}</span>
        <Token color="var(--task-due-tomorrow)">{p('tokenDate')}</Token>
        <Token color="var(--task-priority-high)">{p('tokenPriority')}</Token>
        <span className="flex h-5 items-center rounded-[5px] bg-border px-1.5 text-[11.5px] font-medium text-text-secondary">
          {p('tokenTag')}
        </span>
        <span className="h-4 w-px bg-foreground" />
      </div>
      <div className="flex flex-col">
        <SectionTitle title={p('today')} count={3} color="var(--task-due-today)" />
        <Row title={p('task2')}>
          <span className="flex items-center gap-2">
            <Flag className="size-3 text-[var(--task-priority-high)]" />
            <Project label={p('launch')} className="bg-indigo-400" />
          </span>
        </Row>
        <Row title={p('task1')}>
          <DueToday label={p('today')} />
        </Row>
        <Row title={p('task4')}>
          <DueToday label={p('today')} />
        </Row>
      </div>
      <div className="flex flex-col">
        <SectionTitle title={p('tomorrow')} count={1} color="var(--text-tertiary)" />
        <Row title={p('task5')}>
          <Project label={p('fitness')} className="bg-green-400" />
        </Row>
      </div>
    </div>
  )
}
