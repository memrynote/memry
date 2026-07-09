import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Calendar, ChevronDown, Repeat } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Interactive replica of the desktop app's Today task list.
 * Faithful to apps/desktop tasks UI: round TaskCheckbox (sage fill, hand-drawn check),
 * 3-bar priority glyph, 12px bordered due chips, collapsed green "Done" group.
 * All sample data is hardcoded fiction (July 2026) — deterministic first render.
 */

type Priority = 'high' | 'medium' | 'low' | 'none'
type DueTone = 'overdue' | 'today' | 'neutral'

interface Task {
  id: string
  title: string
  priority: Priority
  due: { label: string; tone: DueTone }
  project?: { name: string; swatch: string }
  repeats?: boolean
}

const TASKS: Task[] = [
  {
    id: 'deposit',
    title: 'Send the venue deposit',
    priority: 'high',
    due: { label: '3d late', tone: 'overdue' },
    project: { name: 'Wedding', swatch: 'bg-terracotta' }
  },
  {
    id: 'q3-doc',
    title: 'Review the Q3 planning doc',
    priority: 'medium',
    due: { label: 'Today', tone: 'today' },
    project: { name: 'Work', swatch: 'bg-sage' }
  },
  {
    id: 'plants',
    title: 'Water the plants',
    priority: 'none',
    due: { label: 'Tomorrow', tone: 'neutral' },
    repeats: true
  },
  {
    id: 'itinerary',
    title: 'Draft the Lisbon itinerary',
    priority: 'low',
    due: { label: 'Sat', tone: 'neutral' },
    project: { name: 'Travel', swatch: 'bg-brand-300' }
  },
  {
    id: 'pages',
    title: 'Morning pages',
    priority: 'none',
    due: { label: 'Today', tone: 'today' }
  }
]

const TASK_BY_ID = new Map(TASKS.map((task) => [task.id, task]))

const ROW_SPRING = { type: 'spring', bounce: 0, duration: 0.3 } as const

/* ── Priority glyph — 3 ascending bars, like the desktop's custom SVG ── */

const PRIORITY_BARS = [
  { x: 2, y: 8, height: 4 },
  { x: 6, y: 5, height: 7 },
  { x: 10, y: 2, height: 10 }
] as const

const PRIORITY_LEVEL: Record<Priority, number> = { high: 3, medium: 2, low: 1, none: 0 }

function PriorityIcon({ priority }: { priority: Priority }) {
  if (priority === 'none') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0" aria-hidden>
        <rect x="2" y="6.25" width="10" height="1.5" rx="0.75" className="fill-muted/40" />
      </svg>
    )
  }
  const level = PRIORITY_LEVEL[priority]
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0" aria-hidden>
      {PRIORITY_BARS.map((bar, i) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="2.5"
          height={bar.height}
          rx="1"
          className={i < level ? 'fill-terracotta' : 'fill-muted/30'}
        />
      ))}
    </svg>
  )
}

/* ── Round checkbox — desktop TaskCheckbox: sage fill, hand-drawn white check ── */

function TaskCheckbox({
  done,
  title,
  onToggle
}: {
  done: boolean
  title: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={done}
      aria-label={done ? `Mark “${title}” as not done` : `Mark “${title}” as done`}
      onClick={onToggle}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full transition-all duration-200',
        'active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta',
        'focus-visible:ring-offset-2 focus-visible:ring-offset-card',
        done ? 'bg-sage' : 'border-[1.5px] border-border hover:border-muted'
      )}
    >
      <AnimatePresence initial={false}>
        {done && (
          <motion.svg
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={ROW_SPRING}
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden
          >
            <path
              d="M2 5l2.5 2.5L8 3"
              stroke="#FAFAF8"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </motion.svg>
        )}
      </AnimatePresence>
    </button>
  )
}

/* ── Due chip — desktop DueDateBadge: 5px radius, 12px calendar icon + label ── */

const DUE_TONE_CLASSES: Record<DueTone, string> = {
  overdue:
    'border-[#dc2626]/40 bg-[#fef2f2] text-[#dc2626] dark:bg-[#dc2626]/10 dark:text-[#f07171]',
  today: 'border-brand-500/40 bg-tint-sand text-brand-600 dark:text-brand-300',
  neutral: 'border-ink/10 bg-ink/[0.03] text-muted'
}

function DueChip({ due }: { due: Task['due'] }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-[5px] border px-2 py-[3px]',
        'text-[12px] leading-4 font-medium',
        DUE_TONE_CLASSES[due.tone]
      )}
    >
      <Calendar className="size-3" aria-hidden />
      {due.label}
    </span>
  )
}

/* ── Task row — desktop TaskRow anatomy: checkbox · priority · title · repeat · project · due ── */

function TaskRow({ task, done, onToggle }: { task: Task; done: boolean; onToggle: () => void }) {
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={ROW_SPRING}
      className="flex items-center gap-3 rounded-md px-3 py-[7px] transition-colors duration-150 hover:bg-paper-alt"
    >
      <TaskCheckbox done={done} title={task.title} onToggle={onToggle} />
      <PriorityIcon priority={task.priority} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[13px] font-medium',
          done
            ? 'text-muted/60 line-through decoration-1 [text-underline-position:from-font]'
            : 'text-ink/90'
        )}
      >
        {task.title}
      </span>
      {task.repeats && <Repeat className="size-3 shrink-0 text-muted/70" aria-hidden />}
      {task.project && (
        <span className="flex max-w-[100px] shrink-0 items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', task.project.swatch)} aria-hidden />
          <span className="truncate text-[11px] leading-3.5 text-muted">{task.project.name}</span>
        </span>
      )}
      <DueChip due={task.due} />
    </motion.li>
  )
}

/**
 * Compact interactive Today list. Checking a task pops the sage check in,
 * strikes the title, and moves the row into the collapsed "Done" group below;
 * checking again un-dones it. Local state only — no network, no storage.
 */
export function TasksWidget({ className }: { className?: string }) {
  const [doneIds, setDoneIds] = useState<string[]>(['pages'])
  const [doneOpen, setDoneOpen] = useState(false)

  const toggle = (id: string) => {
    setDoneIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const openTasks = TASKS.filter((task) => !doneIds.includes(task.id))
  const doneTasks = doneIds
    .map((id) => TASK_BY_ID.get(id))
    .filter((task): task is Task => task !== undefined)

  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-xl border border-border/70 bg-card text-start shadow-sm',
        className
      )}
    >
      {/* Header — inverted "Today" segment like the desktop tab bar, plus a tiny done counter */}
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 rounded-[5px] bg-ink px-2 py-0.5 text-[11px] font-medium text-paper">
          Today
          <span className="font-mono-accent min-w-[2ch] text-[9px] tabular-nums opacity-60">
            {openTasks.length}
          </span>
        </span>
        <span className="font-mono-accent text-[9px] tabular-nums text-muted" aria-live="polite">
          {doneTasks.length} of {TASKS.length} done
        </span>
      </div>

      {/* Open tasks */}
      <ul className="py-1">
        <AnimatePresence initial={false} mode="popLayout">
          {openTasks.map((task) => (
            <TaskRow key={task.id} task={task} done={false} onToggle={() => toggle(task.id)} />
          ))}
        </AnimatePresence>
        {openTasks.length === 0 && (
          <li className="px-3 py-3 text-center text-[12px] text-muted">All done for today</li>
        )}
      </ul>

      {/* Done group — collapsed by default, green header, count increments */}
      <button
        type="button"
        aria-expanded={doneOpen}
        onClick={() => setDoneOpen((open) => !open)}
        className={cn(
          'flex w-full select-none items-center gap-2 bg-ink/[0.02] px-3 py-2 transition-colors',
          'duration-150 hover:bg-ink/[0.04] focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-inset focus-visible:ring-terracotta'
        )}
      >
        <ChevronDown
          className={cn(
            'size-2.5 text-sage transition-transform duration-150',
            !doneOpen && '-rotate-90'
          )}
          aria-hidden
        />
        <span className="text-[12px] font-semibold leading-4 tracking-[0.02em] text-sage">
          Done
        </span>
        <span className="text-[12px] font-medium tabular-nums text-sage/70">
          {doneTasks.length}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {doneOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={ROW_SPRING}
            className="overflow-hidden"
          >
            <ul className="py-1">
              <AnimatePresence initial={false} mode="popLayout">
                {doneTasks.map((task) => (
                  <TaskRow key={task.id} task={task} done onToggle={() => toggle(task.id)} />
                ))}
              </AnimatePresence>
              {doneTasks.length === 0 && (
                <li className="px-3 py-2 text-center text-[11px] text-muted/70">
                  Nothing done yet
                </li>
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
