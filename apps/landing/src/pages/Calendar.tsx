import { Link } from 'react-router'
import { motion } from 'motion/react'
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Briefcase,
  CalendarDays,
  CalendarRange,
  Check,
  CircleDot,
  Clock,
  Eye,
  Flame,
  GraduationCap,
  Hash,
  Keyboard,
  MousePointer2,
  Palette,
  PenLine,
  Repeat,
  Sparkles,
  Sun,
  Sunrise,
  Sunset,
  Target,
  Timer,
  Users,
  type LucideIcon
} from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { FeatureHeroScreenshot } from '@/components/shared/FeatureHeroScreenshot'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import { cn } from '@/lib/utils'

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: EASE_OUT_EXPO }
}

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } }
}

const fadeUpVariant = {
  hidden: { opacity: 0, y: 18 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE_OUT_EXPO } }
}

export function CalendarFeaturePage() {
  return (
    <>
      <PageHead page="calendar" />
      <main>
        <CalendarHero />
        <EverythingInOnePlace />
        <ViewsShowcase />
        <TodayPanelShowcase />
        <PlanningShowcase />
        <StructureSection />
        <WorksWithRest />
        <CalendarUseCases />
        <MoreCalendarFeatures />
        <CalendarFaq />
        <CalendarFinalCta />
      </main>
    </>
  )
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono-accent text-[11px] uppercase tracking-[0.28em] text-muted">
      {children}
    </span>
  )
}

const PROPERTY_TONE: Record<'amber' | 'terracotta' | 'sage', string> = {
  amber: 'bg-amber-500/15 text-amber-700',
  terracotta: 'bg-terracotta/15 text-terracotta',
  sage: 'bg-sage/15 text-sage'
}

function PropertyRow({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: LucideIcon
  label: string
  value: string
  tone: 'amber' | 'terracotta' | 'sage'
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md',
          PROPERTY_TONE[tone]
        )}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      </span>
      <span className="w-20 font-mono-accent text-[11px] uppercase tracking-[0.14em] text-muted">
        {label}
      </span>
      <span className="text-ink/85">{value}</span>
    </div>
  )
}

function CalendarHero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 md:pt-40 md:pb-24">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] bg-[radial-gradient(ellipse_at_top,rgba(255,103,26,0.10),transparent_60%)]"
      />
      <Container size="md">
        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
          className="text-center"
        >
          <Eyebrow>Calendar</Eyebrow>
          <h1 className="mt-4 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
            Your time,
            <br />
            <span className="italic text-terracotta">all in one place.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            The calendar that knows about your tasks, deadlines, and journal entries. Drag to
            reschedule. Plot anything by date. See your week in one glance.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-full px-7" asChild>
              <Link to="/download/desktop">
                Download
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-6 text-ink hover:bg-paper-alt"
              asChild
            >
              <Link to="/features">
                All features
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </motion.div>

        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
          className="mt-14"
        >
          <HeroWeekMock />
        </motion.div>
      </Container>
    </section>
  )
}

function HeroWeekMock() {
  return (
    <FeatureHeroScreenshot
      screenshot="calendar"
      alt="memrynote calendar page showing the weekly calendar, scheduled tasks, and day sidebar"
      width={1608}
      height={944}
    />
  )
}

const ANCHOR_CARDS = [
  {
    icon: CalendarRange,
    title: 'Week view',
    body: 'Seven days at a glance with time-of-day rows. See momentum across the whole week.'
  },
  {
    icon: Sun,
    title: 'Day overview',
    body: 'One day, every task and journal entry, plotted by time. Morning to evening.'
  },
  {
    icon: MousePointer2,
    title: 'Drag to reschedule',
    body: 'Grab any task and drop it on a new day. Due dates update. No menus.'
  },
  {
    icon: CalendarDays,
    title: 'Start + due dates',
    body: 'Plan with both. Time granularity down to the hour. Multi-day spans render as bars.'
  }
] as const

function EverythingInOnePlace() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>One view, every commitment</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Everything in one place.
            <br />
            See your time alongside your work.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Tasks plot by due date. Journal entries land on their day. Deadlines surface as you
            scroll. No second calendar app required.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {ANCHOR_CARDS.map((card) => (
            <motion.article
              key={card.title}
              variants={fadeUpVariant}
              className="group flex flex-col rounded-2xl border border-border/60 bg-card p-6 shadow-card transition-shadow hover:shadow-elevated"
            >
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                <card.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-5 font-serif text-xl text-ink">{card.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{card.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

function ViewsShowcase() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Three lenses</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Zoom in.
            <br />
            <span className="italic text-terracotta">Zoom out.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            A week for momentum. A day for focus. A month for the shape of things. Same vault, three
            perspectives.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          <WeekMiniMock />
          <DayMiniMock />
          <MonthMiniMock />
        </div>
      </Container>
    </section>
  )
}

function SurfaceCard({
  label,
  title,
  body,
  children
}: {
  label: string
  title: string
  body: string
  children: React.ReactNode
}) {
  return (
    <motion.article
      {...fadeUp}
      className="flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-card"
    >
      <div className="border-b border-border/40 bg-paper-alt/60 px-6 py-5">
        <Eyebrow>{label}</Eyebrow>
        <h3 className="mt-2 font-serif text-2xl text-ink">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{body}</p>
      </div>
      <div className="flex-1 px-6 py-7">{children}</div>
    </motion.article>
  )
}

const weekDays = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const weekBlocks: { day: number; top: number; h: number; tone: 'terracotta' | 'sage' | 'amber' }[] =
  [
    { day: 0, top: 10, h: 18, tone: 'sage' },
    { day: 1, top: 30, h: 22, tone: 'terracotta' },
    { day: 2, top: 18, h: 28, tone: 'amber' },
    { day: 3, top: 52, h: 16, tone: 'sage' },
    { day: 4, top: 22, h: 30, tone: 'terracotta' },
    { day: 5, top: 40, h: 14, tone: 'amber' },
    { day: 6, top: 60, h: 18, tone: 'sage' }
  ]
const weekTone: Record<'terracotta' | 'sage' | 'amber', string> = {
  terracotta: 'bg-terracotta/25 border-terracotta/50',
  sage: 'bg-sage/25 border-sage/50',
  amber: 'bg-amber-500/25 border-amber-500/50'
}

function WeekMiniMock() {
  return (
    <SurfaceCard
      label="Week view"
      title="Seven days, one glance."
      body="Time-of-day rows. Multi-day spans cross columns. Today gets a ring."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-3">
        <div className="grid grid-cols-7 gap-1 pb-2 text-center font-mono-accent text-[9px] uppercase tracking-wider text-muted">
          {weekDays.map((d, i) => (
            <span
              key={`${d}-${i}`}
              className={cn(i === 2 && 'rounded-full bg-terracotta px-1 text-white')}
            >
              {d}
            </span>
          ))}
        </div>
        <div className="grid h-32 grid-cols-7 gap-1">
          {weekDays.map((day, i) => (
            <div
              key={`${day}-${i}`}
              className={cn(
                'relative rounded-md border border-border/30 bg-paper-alt/40',
                i === 2 && 'ring-1 ring-terracotta/30'
              )}
            >
              {weekBlocks
                .filter((b) => b.day === i)
                .map((b, idx) => (
                  <span
                    key={idx}
                    className={cn('absolute inset-x-0.5 rounded border', weekTone[b.tone])}
                    style={{ top: `${b.top}%`, height: `${b.h}%` }}
                  />
                ))}
            </div>
          ))}
        </div>
      </div>
    </SurfaceCard>
  )
}

const dayItems: { time: string; label: string; tone: 'terracotta' | 'sage' | 'amber' }[] = [
  { time: '08:30', label: 'Journal entry', tone: 'amber' },
  { time: '09:00', label: 'Standup', tone: 'sage' },
  { time: '10:00', label: 'Deep work · spec', tone: 'terracotta' },
  { time: '13:00', label: 'Customer call', tone: 'sage' },
  { time: '15:30', label: 'Ship beta', tone: 'terracotta' }
]
const dayTone: Record<'terracotta' | 'sage' | 'amber', string> = {
  terracotta: 'border-terracotta bg-terracotta/10 text-terracotta',
  sage: 'border-sage bg-sage/10 text-sage',
  amber: 'border-amber-500 bg-amber-500/10 text-amber-700'
}

function DayMiniMock() {
  return (
    <SurfaceCard
      label="Day view"
      title="One day, in focus."
      body="Time-blocked rows from morning to evening. Click any slot to add a task."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-1.5">
        <ul className="divide-y divide-border/40">
          {dayItems.map((i) => (
            <li key={i.time} className="flex items-center gap-3 px-3 py-2">
              <span className="w-12 font-mono-accent text-[11px] text-muted">{i.time}</span>
              <span
                className={cn(
                  'flex-1 rounded-md border-s-2 bg-paper-alt/40 px-2 py-1 text-[12px]',
                  dayTone[i.tone]
                )}
              >
                {i.label}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </SurfaceCard>
  )
}

function MonthMiniMock() {
  const filled = new Set([2, 3, 5, 8, 9, 12, 14, 15, 16, 19, 21, 23, 26, 28])
  const today = 16
  return (
    <SurfaceCard
      label="Month view"
      title="The shape of the month."
      body="Density at a glance. Jump to any day. Multi-day spans render as bars."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-3">
        <div className="grid grid-cols-7 gap-1 pb-2 text-center font-mono-accent text-[9px] uppercase tracking-wider text-muted">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <span key={`${d}-${i}`}>{d}</span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 30 }).map((_, i) => {
            const day = i + 1
            const isToday = day === today
            const hasItem = filled.has(day)
            return (
              <div
                key={i}
                className={cn(
                  'relative aspect-square rounded-md border border-border/30 bg-paper-alt/30 text-[10px]',
                  isToday && 'ring-1 ring-terracotta bg-terracotta/8'
                )}
              >
                <span
                  className={cn(
                    'absolute inset-x-0 top-0.5 text-center font-mono-accent',
                    isToday ? 'text-terracotta' : 'text-muted'
                  )}
                >
                  {day}
                </span>
                {hasItem && (
                  <span
                    className={cn(
                      'absolute inset-x-1 bottom-1 h-0.5 rounded-full',
                      isToday ? 'bg-terracotta' : 'bg-terracotta/40'
                    )}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </SurfaceCard>
  )
}

type TodayBlock = {
  time: string
  label: string
  tag?: string
  tone: 'terracotta' | 'sage' | 'amber'
  done?: boolean
}

const MORNING: TodayBlock[] = [
  { time: '07:30', label: 'Morning pages', tag: 'Journal', tone: 'amber' },
  { time: '09:00', label: 'Standup', tag: 'memrynote', tone: 'sage', done: true },
  { time: '10:00', label: 'Spec · agent chat permissions', tag: 'memrynote', tone: 'terracotta' }
]

const AFTERNOON: TodayBlock[] = [
  { time: '13:00', label: 'Lunch + walk', tone: 'sage' },
  { time: '14:00', label: 'Pricing page polish', tag: 'Landing', tone: 'terracotta' },
  { time: '16:00', label: 'Customer call · Lin', tag: 'Calls', tone: 'sage' }
]

const EVENING: TodayBlock[] = [
  { time: '18:30', label: 'Ship beta cut', tag: 'memrynote · P0', tone: 'terracotta' },
  { time: '20:00', label: 'Reading · zettelkasten', tone: 'amber' }
]

function TodayPanelShowcase() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Today</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Today, by time of day.
            <br />
            <span className="italic text-terracotta">From wake-up to wind-down.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Tasks group into morning, afternoon, and evening. Journal entries surface as part of the
            day. Deadlines flag themselves before they bite.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <TodayPanel />
          <div className="grid gap-5">
            <DeadlineCard />
            <RecurringCard />
          </div>
        </div>
      </Container>
    </section>
  )
}

const TIME_TONE: Record<'terracotta' | 'sage' | 'amber', string> = {
  terracotta: 'border-terracotta/45 bg-terracotta/8 text-terracotta',
  sage: 'border-sage/45 bg-sage/8 text-sage',
  amber: 'border-amber-500/45 bg-amber-500/8 text-amber-700'
}

function TodayBlockRow({ block }: { block: TodayBlock }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="w-14 font-mono-accent text-[11px] text-muted">{block.time}</span>
      <span
        className={cn(
          'flex flex-1 items-center justify-between gap-3 rounded-lg border-s-2 bg-paper-alt/40 px-3 py-2 text-[13px]',
          TIME_TONE[block.tone]
        )}
      >
        <span className={cn('flex items-center gap-2', block.done && 'text-ink/50 line-through')}>
          {block.done && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
          <span className="font-medium">{block.label}</span>
        </span>
        {block.tag && (
          <span className="hidden font-mono-accent text-[10px] uppercase tracking-wider text-muted sm:inline">
            {block.tag}
          </span>
        )}
      </span>
    </li>
  )
}

function TodaySection({
  icon: Icon,
  label,
  items
}: {
  icon: LucideIcon
  label: string
  items: TodayBlock[]
}) {
  return (
    <div>
      <div className="flex items-center gap-2 px-1 pb-1">
        <Icon className="h-3.5 w-3.5 text-muted" strokeWidth={1.8} />
        <span className="font-mono-accent text-[10px] uppercase tracking-[0.2em] text-muted">
          {label}
        </span>
      </div>
      <ul className="divide-y divide-border/40">
        {items.map((b) => (
          <TodayBlockRow key={`${label}-${b.time}-${b.label}`} block={b} />
        ))}
      </ul>
    </div>
  )
}

function TodayPanel() {
  return (
    <motion.article
      {...fadeUp}
      className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-7 shadow-card md:p-9"
    >
      <div className="flex items-end justify-between">
        <div>
          <Eyebrow>Today</Eyebrow>
          <p className="mt-2 font-serif text-3xl text-ink md:text-4xl">Saturday, May 16</p>
          <p className="mt-1 text-sm text-muted">8 tasks · 1 journal entry · 1 deadline</p>
        </div>
        <span className="hidden items-center gap-2 rounded-full border border-terracotta/30 bg-terracotta/8 px-3 py-1 text-[11px] text-terracotta sm:flex">
          <CircleDot className="h-3 w-3" strokeWidth={2.5} />
          <span className="font-mono-accent uppercase tracking-wider">14:02</span>
        </span>
      </div>

      <div className="mt-7 space-y-5 rounded-xl border border-border/60 bg-paper-alt/40 p-5">
        <TodaySection icon={Sunrise} label="Morning" items={MORNING} />
        <TodaySection icon={Sun} label="Afternoon" items={AFTERNOON} />
        <TodaySection icon={Sunset} label="Evening" items={EVENING} />
      </div>

      <div className="mt-5 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700">
        <PenLine className="h-3.5 w-3.5" strokeWidth={2} />
        <span>Journal entry · drafted at 07:42</span>
      </div>
    </motion.article>
  )
}

function DeadlineCard() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/12 text-amber-700">
          <Bell className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <Eyebrow>Deadlines</Eyebrow>
      </div>
      <h3 className="mt-4 font-serif text-xl text-ink">Three things due this week.</h3>
      <ul className="mt-4 space-y-2.5 text-[13px]">
        <li className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-paper-alt/40 px-3 py-2">
          <span className="text-ink/85">Ship beta cut</span>
          <span className="font-mono-accent text-[11px] text-red-600">today · 18:30</span>
        </li>
        <li className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-paper-alt/40 px-3 py-2">
          <span className="text-ink/85">Pricing copy review</span>
          <span className="font-mono-accent text-[11px] text-amber-700">tue</span>
        </li>
        <li className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-paper-alt/40 px-3 py-2">
          <span className="text-ink/85">Investor update</span>
          <span className="font-mono-accent text-[11px] text-muted">fri</span>
        </li>
      </ul>
    </motion.article>
  )
}

function RecurringCard() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sage/12 text-sage">
          <Repeat className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <Eyebrow>Recurring</Eyebrow>
      </div>
      <h3 className="mt-4 font-serif text-xl text-ink">Plots every cycle.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Daily, weekly, monthly, yearly. memrynote plots each occurrence on the calendar so the
        future is never empty.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {['daily', 'weekly · Mon', 'every 2 weeks', 'monthly · 1st', 'yearly'].map((r) => (
          <span
            key={r}
            className="inline-flex items-center gap-1.5 rounded-full border border-sage/30 bg-sage/8 px-2.5 py-1 font-mono-accent text-[11px] text-sage"
          >
            <Repeat className="h-3 w-3" strokeWidth={2} />
            {r}
          </span>
        ))}
      </div>
    </motion.article>
  )
}

function PlanningShowcase() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.1fr]">
          <motion.div {...fadeUp}>
            <Eyebrow>Planning</Eyebrow>
            <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
              Plan with start <span className="italic text-terracotta">and</span> due dates.
              <br />
              Not just deadlines.
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
              A deadline alone hides the work. Add a start date and memrynote plots the whole span
              on your calendar. You see the runway, not just the finish line.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {[
                { icon: Target, label: 'Start' },
                { icon: Flame, label: 'Due' },
                { icon: Timer, label: 'Duration' },
                { icon: Clock, label: 'Time of day' }
              ].map((p) => (
                <span
                  key={p.label}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm text-ink/85 shadow-sm"
                >
                  <p.icon className="h-3.5 w-3.5 text-terracotta" strokeWidth={1.8} />
                  {p.label}
                </span>
              ))}
            </div>
          </motion.div>

          <motion.div
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.1 }}
            className="rounded-2xl border border-border/60 bg-card p-6 shadow-card md:p-8"
          >
            <div className="flex items-center gap-3 border-b border-border/40 pb-3">
              <span className="text-2xl">🚀</span>
              <h3 className="font-serif text-xl text-ink">Task · Ship landing redesign</h3>
            </div>
            <div className="mt-4 space-y-2 text-[14px]">
              <PropertyRow icon={Target} label="Start" value="Mon, May 11 · 09:00" tone="sage" />
              <PropertyRow icon={Flame} label="Due" value="Fri, May 16 · 18:30" tone="terracotta" />
              <PropertyRow
                icon={Timer}
                label="Duration"
                value="5 days · 1h 30m focus"
                tone="amber"
              />
              <PropertyRow icon={Hash} label="Project" value="Landing" tone="terracotta" />
              <PropertyRow icon={Repeat} label="Repeats" value="No" tone="sage" />
            </div>

            <div className="mt-6 rounded-xl border border-border/60 bg-paper-alt/50 p-4">
              <div className="flex items-center justify-between pb-2 font-mono-accent text-[10px] uppercase tracking-[0.18em] text-muted">
                <span>Mon · 11</span>
                <span>Wed · 13</span>
                <span className="text-terracotta">Fri · 16</span>
              </div>
              <div className="relative h-6 rounded-full bg-paper">
                <span className="absolute inset-y-0 start-0 w-[82%] rounded-full bg-gradient-to-r from-sage/60 via-terracotta/50 to-terracotta" />
                <span className="absolute -end-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-terracotta text-white shadow-glow-terracotta">
                  <Flame className="h-3 w-3" strokeWidth={2.5} />
                </span>
                <span className="absolute -start-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-sage text-white">
                  <Target className="h-3 w-3" strokeWidth={2.5} />
                </span>
              </div>
              <p className="mt-3 font-mono-accent text-[11px] text-muted">
                Renders as a 5-day bar across your week view.
              </p>
            </div>
          </motion.div>
        </div>
      </Container>
    </section>
  )
}

const STRUCTURE_CARDS = [
  {
    icon: MousePointer2,
    title: 'Drag-drop rescheduling',
    body: 'Grab any task pill, drop it on a new day or time. Due date updates everywhere.'
  },
  {
    icon: Repeat,
    title: 'Recurring plot',
    body: 'Daily, weekly, monthly, yearly. Every occurrence renders on the right day.'
  },
  {
    icon: Clock,
    title: 'Time granularity',
    body: 'All-day or down to the hour. Time-of-day rows surface what fits where.'
  },
  {
    icon: Flame,
    title: 'Deadline markers',
    body: 'Due-today gets a flag. Overdue gets a red dot. You see what bites first.'
  },
  {
    icon: CircleDot,
    title: 'Today indicator',
    body: 'A ring on today, a now-line across the day view. You never lose your place.'
  },
  {
    icon: CalendarRange,
    title: 'Multi-day spans',
    body: 'Tasks with a start + due render as a bar across the week. The runway is visible.'
  }
] as const

function StructureSection() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Structure</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for the way time actually works.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            A calendar that reflects your real shape of work. Not a grid of empty cells.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {STRUCTURE_CARDS.map((card) => (
            <motion.article
              key={card.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                <card.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-4 font-serif text-xl text-ink">{card.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{card.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const INTEGRATIONS = [
  {
    icon: Hash,
    title: 'Tasks plot by due date',
    body: 'Set a due date in any view. It appears on the calendar. One source of truth.'
  },
  {
    icon: PenLine,
    title: 'Journal in day context',
    body: 'Today’s entry shows in the day overview. Open it without leaving the calendar.'
  },
  {
    icon: Bell,
    title: 'Inbox deadlines surface',
    body: 'Captured items with dates land on your week. Nothing gets buried under fresh thoughts.'
  }
] as const

function WorksWithRest() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>One workspace</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Works with the rest of memrynote.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Calendar isn’t a separate app. It’s a view on the same vault. Tasks, journal, inbox, all
            aligned to a day.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-3"
        >
          {INTEGRATIONS.map((card) => (
            <motion.article
              key={card.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sage/12 text-sage">
                <card.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-4 font-serif text-xl text-ink">{card.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{card.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const USE_CASES = [
  {
    icon: Briefcase,
    title: 'Knowledge workers',
    body: 'Sprints, standups, and deep work on one grid. Drag the standup to tomorrow when life happens.'
  },
  {
    icon: GraduationCap,
    title: 'Students',
    body: 'Assignment deadlines, exam dates, study blocks. Every course color-coded, every due date visible.'
  },
  {
    icon: Users,
    title: 'Freelancers',
    body: 'Client deliverables next to internal tasks. Multi-day spans show which week is already booked.'
  },
  {
    icon: Target,
    title: 'Founders',
    body: 'Timebox the chaos. Ship dates, investor calls, and journal reflection on the same plane.'
  }
] as const

function CalendarUseCases() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Use cases</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for people who plan in days.
          </h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {USE_CASES.map((u) => (
            <motion.article
              key={u.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                <u.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-4 font-serif text-lg text-ink">{u.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{u.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

type MoreFeature = {
  icon: LucideIcon
  title: string
  body: string
  comingSoon?: boolean
}

const MORE_FEATURES: MoreFeature[] = [
  {
    icon: CalendarDays,
    title: 'External calendar sync',
    body: 'Google and Apple Calendar two-way sync. On the roadmap.',
    comingSoon: true
  },
  {
    icon: Clock,
    title: 'Time-of-day rows',
    body: 'Morning, afternoon, evening lanes. Group the day without locking to a timetable.'
  },
  {
    icon: Keyboard,
    title: 'Keyboard navigation',
    body: 'Arrow keys to move between days. T jumps to today. N adds a task on the focused day.'
  },
  {
    icon: Target,
    title: 'Jump to today',
    body: 'One keystroke snaps back to today, in any view, from any date.'
  },
  {
    icon: Eye,
    title: 'Dense view toggle',
    body: 'Compact mode for triage. Comfortable mode when you want to read every line.'
  },
  {
    icon: Palette,
    title: 'Color by priority or project',
    body: 'Swap the calendar palette by priority (P0 to P4) or project. Same data, new lens.'
  }
]

function MoreCalendarFeatures() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>And more</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Wait. There’s more.
          </h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {MORE_FEATURES.map((m) => (
            <motion.article
              key={m.title}
              variants={fadeUpVariant}
              className="flex items-start gap-4 rounded-2xl border border-border/55 bg-card/60 p-5"
            >
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-terracotta/10 text-terracotta">
                <m.icon className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-serif text-base text-ink">{m.title}</p>
                  {m.comingSoon && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-mono-accent text-[10px] uppercase tracking-wider text-amber-700">
                      <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
                      Coming soon
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted">{m.body}</p>
              </div>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const CALENDAR_FAQ = [
  {
    question: 'Does memrynote sync with Google or Apple Calendar?',
    answer:
      'Not yet. External calendar sync (Google + Apple) is on the roadmap under our Expansion phase. Today, memrynote’s calendar shows tasks, deadlines, and journal entries from your own vault. Not external meetings.'
  },
  {
    question: 'Can I block time on the calendar?',
    answer:
      'Yes. Any task with a start date, due date, and time of day renders as a time-block. Set the duration on the task and it plots as a bar across the day or week.'
  },
  {
    question: 'How do recurring tasks appear?',
    answer:
      'Daily, weekly, monthly, or yearly. Every future occurrence plots on the calendar at the right time. Complete one occurrence and the next stays scheduled. Your future week is never empty.'
  },
  {
    question: 'Can I see tasks that don’t have a due date?',
    answer:
      'Tasks without a due date stay off the calendar by design. The calendar is for dated commitments. Use List or Kanban view for undated tasks. Add a due date there and it appears on the calendar instantly.'
  },
  {
    question: 'What’s the difference between start and due dates?',
    answer:
      'A due date is the deadline. A start date is when work begins. Set both and memrynote plots a multi-day bar across your week so you see the whole runway, not just the finish line.'
  }
]

function CalendarFaq() {
  return (
    <section className="border-t border-border/40 bg-paper-alt/35 py-24">
      <Container size="sm">
        <motion.div {...fadeUp} className="mb-12 text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-4xl">
            Calendar, answered.
          </h2>
        </motion.div>

        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <Accordion type="single" collapsible className="w-full">
            {CALENDAR_FAQ.map((item, i) => (
              <AccordionItem
                key={item.question}
                value={`calendar-faq-${i}`}
                className="rounded-none border-b border-border/55 bg-transparent px-0 last:border-0 data-[state=open]:bg-transparent"
              >
                <AccordionTrigger className="py-5 text-left font-serif text-lg text-ink hover:text-terracotta hover:no-underline">
                  {item.question}
                </AccordionTrigger>
                <AccordionContent className="pb-5 text-[17px] font-sans leading-relaxed text-muted max-w-[92%]">
                  {item.answer}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </Container>
    </section>
  )
}

function CalendarFinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_55%)]"
      />
      <Container size="md">
        <motion.div {...fadeUp} className="text-center">
          <h2 className="mx-auto max-w-2xl font-serif text-4xl font-normal leading-tight text-ink text-balance md:text-5xl">
            Your work + your time. <span className="italic text-terracotta">One view.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Local-first. End-to-end encrypted. Every task, deadline, and journal entry, plotted on a
            calendar you actually own.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-full px-8" asChild>
              <Link to="/download/desktop">
                Download
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-8 text-ink hover:bg-paper-alt"
              asChild
            >
              <Link to="/features">
                See all features
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
