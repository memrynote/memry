import type { ComponentType, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check, Link2, Mic, StickyNote } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HomeSection, MegaCard, SectionTitle } from '@/components/sections/home2/primitives'

/* ── Tasks vignette — a tiny today view with checkbox rows ── */

const TASK_ROWS = [
  { label: 'Review the draft', due: 'Today', done: true },
  { label: 'Book the dentist', due: 'Tomorrow', done: false },
  { label: 'Plan the weekend trip', due: 'Fri', done: false }
] as const

function TasksVignette() {
  return (
    <div className="rounded-xl border border-border/70 bg-paper-alt p-3">
      <p className="mb-2 font-mono-accent text-[9px] uppercase tracking-[0.16em] text-muted">
        Today
      </p>
      <ul className="space-y-1.5">
        {TASK_ROWS.map((row) => (
          <li
            key={row.label}
            className="flex items-center gap-2 rounded-lg bg-card px-2.5 py-1.5 text-xs"
          >
            <span
              className={cn(
                'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                row.done ? 'border-terracotta bg-terracotta' : 'border-muted/50'
              )}
            >
              {row.done && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
            </span>
            <span className={cn('truncate text-ink', row.done && 'text-muted line-through')}>
              {row.label}
            </span>
            <span className="ms-auto shrink-0 rounded-full bg-paper-deep px-1.5 py-0.5 text-[9px] font-medium text-muted">
              {row.due}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── Calendar vignette — a mini month grid with event + note dots ── */

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1)
const EVENT_DAYS = new Set([3, 12, 18])
const NOTE_DAYS = new Set([5, 16, 24])
const TODAY = 10

function CalendarVignette() {
  return (
    <div className="rounded-xl border border-border/70 bg-paper-alt p-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <p className="font-mono-accent text-[9px] uppercase tracking-[0.16em] text-muted">July</p>
        <p className="text-[9px] text-muted/70">Notes + events</p>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {DOW.map((day, i) => (
          <span key={i} className="text-[8px] font-medium text-muted/70">
            {day}
          </span>
        ))}
        {MONTH_DAYS.map((day) => (
          <span
            key={day}
            className={cn(
              'relative flex h-5 items-center justify-center rounded-md text-[9px]',
              day === TODAY ? 'bg-terracotta font-semibold text-white' : 'text-ink/70'
            )}
          >
            {day}
            {day !== TODAY && (EVENT_DAYS.has(day) || NOTE_DAYS.has(day)) && (
              <span
                className={cn(
                  'absolute bottom-0 h-1 w-1 rounded-full',
                  EVENT_DAYS.has(day) ? 'bg-terracotta/70' : 'bg-sage'
                )}
              />
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ── Journal vignette — a dated daily entry ── */

function JournalVignette() {
  return (
    <div className="rounded-xl border border-border/70 bg-paper-alt p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <p className="font-mono-accent text-[9px] uppercase tracking-[0.16em] text-terracotta">
          Today
        </p>
        <p className="text-[9px] text-muted/70">Daily note</p>
      </div>
      <div className="rounded-lg bg-card px-3 py-2.5">
        <p className="text-xs leading-relaxed text-ink">
          Slow morning. Finished the draft, walked at noon.
        </p>
        <div className="mt-2 space-y-1.5">
          <div className="h-1.5 w-full rounded-full bg-ink/10" />
          <div className="h-1.5 w-3/4 rounded-full bg-ink/10" />
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        {['Yesterday', 'Tue', 'Mon'].map((day) => (
          <span
            key={day}
            className="rounded-full bg-paper-deep px-2 py-0.5 text-[9px] font-medium text-muted"
          >
            {day}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ── Inbox vignette — captured scraps waiting to be sorted ── */

const INBOX_ROWS: { icon: ComponentType<{ className?: string }>; label: string; meta: string }[] = [
  { icon: StickyNote, label: 'Idea: quieter home screen', meta: '2m' },
  { icon: Link2, label: 'article-worth-reading.com', meta: '1h' },
  { icon: Mic, label: 'Voice memo · 0:32', meta: '3h' }
]

function InboxVignette() {
  return (
    <div className="rounded-xl border border-border/70 bg-paper-alt p-3">
      <p className="mb-2 font-mono-accent text-[9px] uppercase tracking-[0.16em] text-muted">
        Inbox · 3
      </p>
      <ul className="space-y-1.5">
        {INBOX_ROWS.map((row) => (
          <li
            key={row.label}
            className="flex items-center gap-2 rounded-lg bg-card px-2.5 py-1.5 text-xs"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-terracotta/10 text-terracotta">
              <row.icon className="h-3 w-3" />
            </span>
            <span className="truncate text-ink">{row.label}</span>
            <span className="ms-auto shrink-0 text-[9px] text-muted/70">{row.meta}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── Quadrant card — links each mini-tour to its feature page ── */

interface QuadrantProps {
  title: string
  desc: string
  href: string
  children: ReactNode
}

function Quadrant({ title, desc, href, children }: QuadrantProps) {
  return (
    <Link
      to={href}
      className={cn(
        'group flex flex-col gap-5 rounded-2xl border border-ink/5 bg-card p-5 shadow-sm sm:p-6',
        'transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-card'
      )}
    >
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-ink">
          {title}
          <span
            aria-hidden
            className="text-terracotta opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:opacity-100"
          >
            →
          </span>
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">{desc}</p>
      </div>
      <div aria-hidden className="mt-auto">
        {children}
      </div>
    </Link>
  )
}

/**
 * Plan mega-card — warm sand tint, 2×2 quadrant of Tasks / Calendar / Journal / Inbox,
 * each with a tiny hand-built UI vignette linking to its feature page.
 */
export function PlanShowcase() {
  return (
    <HomeSection>
      <MegaCard tint="sand" eyebrow="PLAN">
        <SectionTitle
          title="Planning that doesn't feel like work"
          sub="Tasks, calendar, journal, and inbox — next to your notes, not in four other apps."
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-5">
          <Quadrant
            title="Tasks"
            desc="A today view with natural due dates — “tomorrow” just works."
            href="/features/tasks"
          >
            <TasksVignette />
          </Quadrant>
          <Quadrant
            title="Calendar"
            desc="Notes and events together, on one calendar."
            href="/features/calendar"
          >
            <CalendarVignette />
          </Quadrant>
          <Quadrant
            title="Journal"
            desc="A daily note that's ready when you are. No streaks, no guilt."
            href="/features/journal"
          >
            <JournalVignette />
          </Quadrant>
          <Quadrant
            title="Inbox"
            desc="Capture now, sort later — text, links, voice."
            href="/features/inbox"
          >
            <InboxVignette />
          </Quadrant>
        </div>
      </MegaCard>
    </HomeSection>
  )
}
