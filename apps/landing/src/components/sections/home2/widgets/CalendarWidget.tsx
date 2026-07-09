import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CircleDashed } from 'lucide-react'
import { cn } from '@/lib/utils'

/*
 * Interactive replica of the desktop app's global day panel:
 * mini month (DatePickerCalendar) + agenda strip (JournalDayPanel).
 * All dates are hardcoded fiction — July 2026, "today" pinned to Fri, Jul 10.
 */

/* ── Fixed per-type colors (verbatim from the desktop's event-type-colors.ts) ── */

const TYPE_COLORS = {
  event: '#92CED4',
  external: '#9A9CFF',
  task: '#1EB06D',
  reminder: '#1BADF8',
  note: '#E0A458',
  noteDate: '#B57BD6'
} as const

type ItemKind = keyof typeof TYPE_COLORS

const DOT_ORDER: ItemKind[] = ['event', 'external', 'task', 'reminder', 'note', 'noteDate']

interface DayItem {
  kind: ItemKind
  title: string
  time?: string
  source?: string
  done?: boolean
}

/* ── Sample data: items live only in July 2026 ── */

const JULY_ITEMS: Record<number, DayItem[]> = {
  2: [{ kind: 'event', title: 'Coffee with Ana', time: '9:00 AM - 9:45 AM' }],
  6: [{ kind: 'task', title: 'Send the invoice', done: true }],
  10: [
    { kind: 'event', title: 'Design review', time: '10:00 AM - 11:00 AM' },
    { kind: 'external', title: 'Dentist', time: '2:00 PM - 2:30 PM', source: 'Google' },
    { kind: 'note', title: 'Trip ideas — Kyoto' },
    { kind: 'task', title: 'Ship the landing hero', done: false }
  ],
  14: [
    { kind: 'event', title: 'Standup', time: '9:30 AM - 9:45 AM' },
    { kind: 'note', title: 'Reading list' }
  ],
  17: [{ kind: 'reminder', title: 'Renew passport', time: '6:00 PM' }],
  21: [
    { kind: 'noteDate', title: 'Draft due — landing copy' },
    { kind: 'task', title: 'Review the PR', done: false }
  ]
}

/* ── Hardcoded month geometry (Monday-start, real weekdays for mid-2026) ── */

interface MonthDef {
  label: string
  short: string
  days: number
  firstCol: number
  prevShort: string
  prevDays: number
  nextShort: string
}

const MONTHS: MonthDef[] = [
  {
    label: 'June 2026',
    short: 'Jun',
    days: 30,
    firstCol: 0,
    prevShort: 'May',
    prevDays: 31,
    nextShort: 'Jul'
  },
  {
    label: 'July 2026',
    short: 'Jul',
    days: 31,
    firstCol: 2,
    prevShort: 'Jun',
    prevDays: 30,
    nextShort: 'Aug'
  },
  {
    label: 'August 2026',
    short: 'Aug',
    days: 31,
    firstCol: 5,
    prevShort: 'Jul',
    prevDays: 31,
    nextShort: 'Sep'
  }
]

const JULY_INDEX = 1
const TODAY = { short: 'Jul', day: 10 }

const WEEKDAY_SHORT = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const
const WEEKDAY_FULL = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
] as const
const MONTH_FULL: Record<string, string> = {
  May: 'May',
  Jun: 'June',
  Jul: 'July',
  Aug: 'August',
  Sep: 'September'
}

interface DayCell {
  day: number
  short: string
  inMonth: boolean
}

function buildWeeks(month: MonthDef): DayCell[][] {
  const cells: DayCell[] = []
  for (let i = month.firstCol - 1; i >= 0; i--) {
    cells.push({ day: month.prevDays - i, short: month.prevShort, inMonth: false })
  }
  for (let day = 1; day <= month.days; day++) {
    cells.push({ day, short: month.short, inMonth: true })
  }
  let next = 1
  while (cells.length % 7 !== 0) {
    cells.push({ day: next++, short: month.nextShort, inMonth: false })
  }
  const weeks: DayCell[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7))
  }
  return weeks
}

function itemsFor(short: string, day: number): DayItem[] {
  return short === 'Jul' ? (JULY_ITEMS[day] ?? []) : []
}

function dotColors(items: DayItem[]): string[] {
  return [...items]
    .sort((a, b) => DOT_ORDER.indexOf(a.kind) - DOT_ORDER.indexOf(b.kind))
    .slice(0, 3)
    .map((item) => TYPE_COLORS[item.kind])
}

/* ── Agenda rows (JournalDayPanel look: colored left-border rows, not chips) ── */

function ScheduleRow({
  item,
  onHover
}: {
  item: DayItem
  onHover: (color: string | null) => void
}) {
  return (
    <div
      className="rounded-e border-s-2 ps-2.5 pe-2 py-1 transition-colors hover:bg-paper-alt/60"
      style={{ borderColor: TYPE_COLORS[item.kind] }}
      onMouseEnter={() => onHover(TYPE_COLORS[item.kind])}
      onMouseLeave={() => onHover(null)}
    >
      <div className="flex items-center gap-2">
        <p className="truncate text-[13px] font-medium text-ink/90">{item.title}</p>
        {item.source && (
          <span className="ms-auto shrink-0 rounded bg-paper-deep px-1.5 py-0.5 text-[10px] font-medium text-muted">
            {item.source}
          </span>
        )}
      </div>
      {item.time && <p className="font-mono text-[11px] tabular-nums text-muted/70">{item.time}</p>}
    </div>
  )
}

function TaskRow({ item }: { item: DayItem }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-[5px] transition-colors hover:bg-paper-alt/60">
      {item.done ? (
        <CircleCheck className="h-4 w-4 shrink-0" style={{ color: '#7B9E87' }} aria-hidden />
      ) : (
        <CircleDashed className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      )}
      <span
        className={cn(
          'truncate text-[13px] font-medium text-ink/90',
          item.done && 'text-muted/60 line-through'
        )}
      >
        {item.title}
      </span>
    </div>
  )
}

/* ── Widget ── */

export function CalendarWidget({ className }: { className?: string }) {
  const [monthIdx, setMonthIdx] = useState(JULY_INDEX)
  const [selected, setSelected] = useState<{ short: string; day: number }>({ ...TODAY })
  const [agendaOpen, setAgendaOpen] = useState(true)
  const [hoverColor, setHoverColor] = useState<string | null>(null)

  const month = MONTHS[monthIdx]
  const weeks = buildWeeks(month)
  const items = itemsFor(selected.short, selected.day)
  const scheduleItems = items.filter((item) => item.kind !== 'task')
  const taskItems = items.filter((item) => item.kind === 'task')
  const selectedIsToday = selected.short === TODAY.short && selected.day === TODAY.day
  const agendaLabel = selectedIsToday ? 'Today' : `${selected.short} ${selected.day}`

  const selectDay = (cell: DayCell) => {
    setSelected({ short: cell.short, day: cell.day })
    setHoverColor(null)
  }

  const goToday = () => {
    setMonthIdx(JULY_INDEX)
    setSelected({ ...TODAY })
    setHoverColor(null)
  }

  const navButton =
    'flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors ' +
    'hover:text-ink disabled:opacity-30 disabled:hover:text-muted ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/70'

  return (
    <div
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-xl border border-border/70 bg-card pt-2 pb-1',
        'text-[12px] leading-4 [font-synthesis:none]',
        className
      )}
    >
      {/* Month nav */}
      <div className="flex items-center justify-between px-2.5">
        <button
          type="button"
          aria-label="Previous month"
          disabled={monthIdx === 0}
          onClick={() => setMonthIdx((i) => Math.max(0, i - 1))}
          className={navButton}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        </button>
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-ink">{month.label}</span>
          <button
            type="button"
            onClick={goToday}
            className={cn(
              'rounded-md border border-border/60 px-1.5 py-0.5 text-[10px] text-muted',
              'transition-colors hover:bg-paper-deep/50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/70'
            )}
          >
            Today
          </button>
        </div>
        <button
          type="button"
          aria-label="Next month"
          disabled={monthIdx === MONTHS.length - 1}
          onClick={() => setMonthIdx((i) => Math.min(MONTHS.length - 1, i + 1))}
          className={navButton}
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {/* Weekday header */}
      <div className="flex px-2" aria-hidden>
        {WEEKDAY_SHORT.map((label) => (
          <span key={label} className="flex-1 text-center text-[10px] font-medium text-muted/60">
            {label}
          </span>
        ))}
      </div>

      {/* Day grid */}
      <div className="flex flex-col px-2">
        {weeks.map((week, weekIdx) => (
          <div key={weekIdx} className="flex">
            {week.map((cell, colIdx) => {
              const isToday = cell.short === TODAY.short && cell.day === TODAY.day
              const isSelected = cell.short === selected.short && cell.day === selected.day
              const isPast =
                !isToday &&
                (cell.short === 'May' ||
                  cell.short === 'Jun' ||
                  (cell.short === 'Jul' && cell.day < TODAY.day))
              const dots = dotColors(itemsFor(cell.short, cell.day))
              return (
                <button
                  key={`${cell.short}-${cell.day}`}
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${WEEKDAY_FULL[colIdx]}, ${MONTH_FULL[cell.short]} ${cell.day}`}
                  onClick={() => selectDay(cell)}
                  className={cn(
                    'relative flex aspect-square max-h-10 flex-1 flex-col items-center justify-center gap-0.5',
                    'rounded-[5px] text-[11px] transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/70',
                    isSelected
                      ? 'bg-ink font-semibold text-paper'
                      : cn(
                          'hover:bg-paper-alt',
                          isToday && 'border border-ink/15 font-medium text-ink',
                          !isToday &&
                            (!cell.inMonth ? 'text-ink/30' : isPast ? 'text-muted' : 'text-ink/80')
                        )
                  )}
                >
                  {isSelected && hoverColor && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-[5px]"
                      style={{ backgroundColor: `${hoverColor}33` }}
                    />
                  )}
                  <span>{cell.day}</span>
                  <span className="flex h-1 items-center gap-[2px]" aria-hidden>
                    {dots.map((color, dotIdx) => (
                      <span
                        key={dotIdx}
                        className="h-1 w-1 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* Divider */}
      <div className="mx-4 h-px bg-border/30" aria-hidden />

      {/* Agenda strip */}
      <div className="flex flex-col gap-2 px-3.5 pt-1.5 pb-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
            {agendaLabel}
          </p>
          <button
            type="button"
            aria-expanded={agendaOpen}
            aria-label={agendaOpen ? 'Collapse agenda' : 'Expand agenda'}
            onClick={() => setAgendaOpen((open) => !open)}
            className="flex h-5 w-5 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/70"
          >
            <ChevronDown
              className={cn(
                'h-4 w-4 text-ink/70 transition-transform duration-200',
                !agendaOpen && 'rotate-180'
              )}
              aria-hidden
            />
          </button>
        </div>
        {agendaOpen && (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${selected.short}-${selected.day}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="flex flex-col gap-1"
            >
              {items.length === 0 && <p className="py-0.5 text-xs text-muted">Nothing scheduled</p>}
              {scheduleItems.map((item) => (
                <ScheduleRow key={item.title} item={item} onHover={setHoverColor} />
              ))}
              {taskItems.length > 0 && (
                <>
                  <p className="pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
                    Tasks
                  </p>
                  {taskItems.map((item) => (
                    <TaskRow key={item.title} item={item} />
                  ))}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
