import type { ComponentType, CSSProperties } from 'react'
import { motion } from 'motion/react'
import { Link } from 'react-router'
import {
  ArrowRight,
  Bookmark,
  CalendarDays,
  FileText,
  NotebookPen,
  SquareCheck
} from 'lucide-react'
import { Mascot } from '@/components/ui/mascot'
import { MemoMascot } from '@/components/ui/memo-mascot'
import { HomeSection } from '@/components/site/primitives'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

type ChipKind = 'note' | 'task' | 'event' | 'journal' | 'saved'

const CHIP_ICONS: Record<ChipKind, ComponentType<{ className?: string }>> = {
  note: FileText,
  task: SquareCheck,
  event: CalendarDays,
  journal: NotebookPen,
  saved: Bookmark
}

interface RainColumn {
  /** Seconds for one full loop — each column drifts at its own pace. */
  duration: number
  /** Head start so the columns never line up into a grid. */
  offset: number
  chips: { label: string; kind: ChipKind }[]
}

const RAIN_COLUMNS: RainColumn[] = [
  {
    duration: 12,
    offset: 0,
    chips: [
      { label: 'Meeting notes', kind: 'note' },
      { label: 'Standup 09:30', kind: 'event' },
      { label: 'Untitled', kind: 'note' },
      { label: 'Draft the reply', kind: 'task' },
      { label: 'Untitled 3', kind: 'note' },
      { label: 'Call mom', kind: 'task' },
      { label: 'Fix my resume', kind: 'task' },
      { label: 'Budget spreadsheet', kind: 'note' },
      { label: 'Follow up w/ Ada', kind: 'task' },
      { label: 'Saved article', kind: 'saved' }
    ]
  },
  {
    duration: 15,
    offset: 34,
    chips: [
      { label: 'Trip planning', kind: 'note' },
      { label: 'Where did I write it?', kind: 'note' },
      { label: 'Newsletter cleanup', kind: 'task' },
      { label: 'Invoice — Mar', kind: 'saved' },
      { label: 'Book flights', kind: 'task' },
      { label: 'That one link', kind: 'saved' },
      { label: 'Q3 review doc', kind: 'note' },
      { label: 'Untitled (2)', kind: 'note' },
      { label: 'Felt off today', kind: 'journal' },
      { label: 'Dentist 14:00', kind: 'event' }
    ]
  },
  {
    duration: 13,
    offset: 12,
    chips: [
      { label: 'Ideas dump', kind: 'note' },
      { label: 'Renew passport', kind: 'task' },
      { label: 'Same doc, next section', kind: 'note' },
      { label: '1:1 notes', kind: 'note' },
      { label: 'New doc', kind: 'note' },
      { label: 'Groceries', kind: 'task' },
      { label: 'Gym 07:00', kind: 'event' },
      { label: 'Client follow-up', kind: 'task' },
      { label: 'Quick question', kind: 'note' },
      { label: 'Weekly status', kind: 'note' }
    ]
  }
]

/** The sliver of rain above the copy: faint, fading out at both ends. */
const RAIN_MASK_TOP =
  'linear-gradient(to bottom, transparent 0%, rgba(0, 0, 0, 0.34) 34%, rgba(0, 0, 0, 0.34) 66%, transparent 100%)'

/** The main field below the copy: eases in, holds, then dissolves at the bottom edge. */
const RAIN_MASK_MAIN =
  'linear-gradient(to bottom, transparent 0%, rgba(0, 0, 0, 0.3) 7%, #000 24%, #000 74%, transparent 100%)'

interface Satellite {
  key: string
  label: string
  desc: string
  iconSrc: string
}

const SATELLITES: Satellite[] = [
  { key: 'notes', label: 'Notes', desc: 'Where thinking lands', iconSrc: '/mascots/notes.png' },
  { key: 'tasks', label: 'Tasks', desc: 'What actually gets done', iconSrc: '/mascots/tasks.png' },
  {
    key: 'calendar',
    label: 'Calendar',
    desc: 'Where the day fits',
    iconSrc: '/mascots/calendar.png'
  },
  { key: 'journal', label: 'Journal', desc: 'How it felt', iconSrc: '/mascots/journal.png' },
  { key: 'inbox', label: 'Inbox', desc: 'Everything you saved', iconSrc: '/mascots/inbox.png' }
]

/**
 * Ring geometry is a fixed pixel diagram, not a text layout: the connector SVG is drawn in the
 * same coordinate space as the satellites, so these stay physical `left`/`top` rather than
 * logical insets — mirroring the satellites without the lines would break the drawing.
 */
type Placement = {
  top: number
  left?: number
  right?: number
  width: number
  /** Label sits to the start of the icon instead of the end. */
  reverse?: boolean
  /** Label sits under the icon — used for the satellite at the top of the ring. */
  stack?: boolean
}

const WIDE_PLACEMENT: Record<string, Placement> = {
  notes: { top: 40, left: 230, width: 160, stack: true },
  tasks: { top: 157, left: 438, width: 182 },
  calendar: { top: 335, left: 380, width: 240 },
  journal: { top: 335, right: 380, width: 240, reverse: true },
  inbox: { top: 157, right: 438, width: 182, reverse: true }
}

const COMPACT_PLACEMENT: Record<string, Placement> = {
  notes: { top: 18, left: 129, width: 84 },
  tasks: { top: 95, left: 236, width: 84 },
  calendar: { top: 221, left: 195, width: 84 },
  journal: { top: 221, left: 63, width: 84 },
  inbox: { top: 95, left: 22, width: 84 }
}

function RainChip({ label, kind }: { label: string; kind: ChipKind }) {
  const Icon = CHIP_ICONS[kind]

  return (
    <div className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-card/80 px-3 py-2.5">
      <Icon className="size-3.5 shrink-0 text-muted/70" />
      <span className="truncate text-[13px] font-medium text-muted">{label}</span>
    </div>
  )
}

function RainLane({ column, className }: { column: RainColumn; className?: string }) {
  return (
    <div className={cn('min-w-0 flex-1', className)} style={{ paddingTop: column.offset }}>
      <div
        className="rain-track flex flex-col gap-3"
        style={{ '--rain-duration': `${column.duration}s` } as CSSProperties}
      >
        {/* Two identical passes: the track scrolls exactly one pass, so the loop has no seam. */}
        {[0, 1].map((pass) => (
          <div key={pass} className="flex flex-col gap-3">
            {column.chips.map((chip) => (
              <RainChip key={`${pass}-${chip.label}`} label={chip.label} kind={chip.kind} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function SatelliteCard({
  satellite,
  placement,
  index,
  compact
}: {
  satellite: Satellite
  placement: Placement
  index: number
  compact: boolean
}) {
  return (
    <div
      className="absolute"
      style={{
        top: placement.top,
        left: placement.left,
        right: placement.right,
        width: placement.width
      }}
    >
      <div
        className={cn(
          'orbit-breathe flex items-center gap-3',
          compact || placement.stack
            ? 'flex-col gap-2 text-center'
            : placement.reverse && 'flex-row-reverse'
        )}
        style={{ '--breathe-delay': `${index * 0.7}s` } as CSSProperties}
      >
        <Mascot
          src={satellite.iconSrc}
          className={cn('shrink-0', compact ? 'h-10 w-10' : 'h-12 w-12')}
        />
        <div
          className={cn(
            'flex flex-col gap-0.5',
            compact || placement.stack ? 'items-center' : placement.reverse && 'items-end text-end'
          )}
        >
          <span className={cn('font-semibold text-ink', compact ? 'text-xs' : 'text-[15px]')}>
            {satellite.label}
          </span>
          {!compact && <span className="text-[12.5px] text-muted">{satellite.desc}</span>}
        </div>
      </div>
    </div>
  )
}

function WideOrbit() {
  return (
    <div className="relative hidden h-[460px] w-[620px] lg:block">
      <svg
        viewBox="0 0 620 460"
        fill="none"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
      >
        <circle
          cx="310"
          cy="230"
          r="160"
          stroke="var(--color-border)"
          strokeWidth="1"
          strokeDasharray="2 7"
        />
        {[
          'M310 172 L310 94',
          'M365.2 212.1 L439.3 188',
          'M344.1 276.9 L390 340',
          'M275.9 276.9 L230 340',
          'M254.8 212.1 L180.7 188'
        ].map((d) => (
          <path
            key={d}
            d={d}
            stroke="var(--color-terracotta-glow)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ))}
      </svg>
      <MemoMascot className="absolute h-[120px] w-[120px]" style={{ left: 250, top: 170 }} />
      {SATELLITES.map((satellite, i) => (
        <SatelliteCard
          key={satellite.key}
          satellite={satellite}
          placement={WIDE_PLACEMENT[satellite.key]}
          index={i}
          compact={false}
        />
      ))}
    </div>
  )
}

function CompactOrbit() {
  return (
    <div className="relative h-[300px] w-[342px] origin-top scale-[0.86] sm:scale-100 lg:hidden">
      <svg
        viewBox="0 0 342 300"
        fill="none"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
      >
        <circle
          cx="171"
          cy="150"
          r="112"
          stroke="var(--color-border)"
          strokeWidth="1"
          strokeDasharray="2 7"
        />
        {[
          'M171 104 L171 62',
          'M214.7 135.8 L254.7 122.8',
          'M198 187.2 L222.7 221.2',
          'M144 187.2 L119.3 221.2',
          'M127.3 135.8 L87.3 122.8'
        ].map((d) => (
          <path
            key={d}
            d={d}
            stroke="var(--color-terracotta-glow)"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        ))}
      </svg>
      <MemoMascot className="absolute h-[84px] w-[84px]" style={{ left: 129, top: 108 }} />
      {SATELLITES.map((satellite, i) => (
        <SatelliteCard
          key={satellite.key}
          satellite={satellite}
          placement={COMPACT_PLACEMENT[satellite.key]}
          index={i}
          compact
        />
      ))}
    </div>
  )
}

function RainField({ mask, className }: { mask: string; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none flex gap-3 overflow-hidden', className)}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {RAIN_COLUMNS.map((column, i) => (
        <RainLane
          key={column.duration}
          column={column}
          className={i === 2 ? 'hidden sm:block' : undefined}
        />
      ))}
    </div>
  )
}

/**
 * "Everywhere else / here" contrast pair: the left panel rains the fragments other apps leave
 * behind, the right panel gathers the same day around one mascot.
 */
export function SplitVsOne() {
  return (
    <HomeSection id="split-vs-one">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.8, ease: EASE }}
        className="mx-auto w-full max-w-7xl"
      >
        <div className="grid lg:grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]">
          <div className="flex min-w-0 flex-col px-6 pb-12 sm:px-10">
            {/* Rain runs above and below the copy, never behind it — the 88px band keeps the two
                panels' headings on the same baseline. */}
            <RainField mask={RAIN_MASK_TOP} className="h-[88px]" />

            <div className="flex flex-col gap-3">
              <p className="font-mono-accent text-[11px] uppercase tracking-[0.14em] text-muted">
                Everywhere else
              </p>
              <h3 className="max-w-[420px] text-[42px] font-normal leading-[45px]! tracking-tight text-ink">
                Your day gets split up.
              </h3>
              <p className="max-w-[400px] text-base leading-relaxed text-muted">
                A note here. A task there. An event somewhere else. Nothing ever adds up.
              </p>
            </div>

            <RainField mask={RAIN_MASK_MAIN} className="mt-8 h-[380px] lg:h-[520px]" />
          </div>

          <div className="flex min-w-0 flex-col items-center gap-8 px-6 pb-12 pt-[88px] sm:px-10 lg:items-start">
            <div className="flex w-full flex-col gap-3">
              <p className="font-mono-accent text-[11px] uppercase tracking-[0.14em] text-terracotta">
                With MemryNote
              </p>
              <h3 className="max-w-[560px] text-[42px] font-normal leading-[45px]! tracking-tight text-ink">
                It all stays in one place.
              </h3>
              <p className="max-w-[480px] text-base leading-relaxed text-muted lg:text-[17px]">
                Notes, tasks, calendar, journal and everything you saved — one window, one memory.
              </p>
            </div>

            <div className="flex w-full min-w-0 flex-col items-center gap-6">
              <WideOrbit />
              <div className="flex w-full justify-center overflow-hidden lg:contents">
                <CompactOrbit />
              </div>
              <Link
                to="/features"
                className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-4 py-2.5 text-[13px] font-medium text-muted transition-colors hover:text-ink"
              >
                Canvas, Graph, Search — same window
                <ArrowRight className="size-3.5 text-terracotta" />
              </Link>
            </div>
          </div>
        </div>
      </motion.div>
    </HomeSection>
  )
}
