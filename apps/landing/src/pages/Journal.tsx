import { Link } from 'react-router'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Calendar,
  CheckSquare,
  ChevronRight,
  Clock,
  FileCode,
  Flame,
  Heart,
  Inbox,
  Layers,
  MessageSquare,
  Moon,
  PanelLeft,
  PenTool,
  Sparkles,
  Sun,
  Target,
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

export function JournalFeaturePage() {
  return (
    <>
      <PageHead page="journal" />
      <main>
        <JournalHero />
        <EverythingInOnePlace />
        <RhythmShowcase />
        <DayContextShowcase />
        <ActivityHeatmapShowcase />
        <StructureRitual />
        <WorksWithRest />
        <JournalUseCases />
        <MoreJournalFeatures />
        <JournalFaq />
        <JournalFinalCta />
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

function JournalHero() {
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
          <Eyebrow>Journal</Eyebrow>
          <h1 className="mt-4 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
            Reflect.
            <br />
            <span className="italic text-terracotta">Daily.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            A premium daily writing experience with rich context and statistics. Build your writing
            habit, one entry at a time.
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
          <HeroJournalMock />
        </motion.div>
      </Container>
    </section>
  )
}

function HeroJournalMock() {
  return (
    <FeatureHeroScreenshot
      screenshot="journal"
      alt="memrynote journal page showing the daily entry, day context, calendar, and tasks"
      width={1608}
      height={944}
    />
  )
}

const ANCHOR_CARDS = [
  {
    icon: PenTool,
    title: 'Date-stamped entries',
    body: 'One entry per day, stored as plain .md beside everything else in your vault.'
  },
  {
    icon: PanelLeft,
    title: 'Day context sidebar',
    body: 'Schedule, tasks, and linked notes for the day — right next to the page.'
  },
  {
    icon: FileCode,
    title: 'Templates',
    body: 'Start each day from a structure you keep coming back to. Pre-filled prompts ready.'
  },
  {
    icon: Flame,
    title: 'Activity heatmap',
    body: 'Watch the habit form. A simple grid that rewards showing up.'
  }
] as const

function EverythingInOnePlace() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>The daily ritual</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Everything you need to show up.
            <br />
            Nothing in the way.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Open the journal, see today, write. Context, templates, and history are there when you
            want them.
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

function RhythmShowcase() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>The rhythm</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            A page that knows the day.
            <br />
            <span className="italic text-terracotta">And the year.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Time-based greetings open the page. Monthly stats hold the receipts. A yearly overview
            shows the whole arc.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1fr_1fr_1.1fr]">
          <GreetingMock />
          <MonthlyStatsMock />
          <YearlyOverviewMock />
        </div>
      </Container>
    </section>
  )
}

function ShowcaseCard({
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

const greetings: { icon: LucideIcon; time: string; text: string; active?: boolean }[] = [
  { icon: Sun, time: '06:00', text: 'Good morning, Kaan.' },
  { icon: Sun, time: '12:00', text: 'Hope the day is going well.' },
  { icon: Moon, time: '20:00', text: 'Good evening, Kaan.', active: true },
  { icon: Moon, time: '23:30', text: 'Late night thoughts?' }
]

function GreetingMock() {
  return (
    <ShowcaseCard
      label="Greeting"
      title="The page meets you where you are."
      body="A small touch — but the day feels different at 7am than it does at midnight."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-1.5 shadow-inner">
        <div className="px-3 pb-2 pt-1.5 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
          By time of day
        </div>
        <ul className="space-y-0.5">
          {greetings.map((g) => (
            <li
              key={g.time}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm',
                g.active ? 'bg-terracotta/10 text-terracotta' : 'text-ink/80'
              )}
            >
              <span className="flex items-center gap-2.5">
                <g.icon className="h-4 w-4" strokeWidth={1.8} />
                {g.text}
              </span>
              <span className="font-mono-accent text-[11px] tracking-wide text-muted">
                {g.time}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ShowcaseCard>
  )
}

function MonthlyStatsMock() {
  return (
    <ShowcaseCard
      label="Monthly stats"
      title="The month at a glance."
      body="Entry count, word count, and average activity — without leaving the journal."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-5">
        <p className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
          May 2026
        </p>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <p className="font-serif text-3xl text-ink">14</p>
            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted">Entries</p>
          </div>
          <div>
            <p className="font-serif text-3xl text-ink">6.2k</p>
            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted">Words</p>
          </div>
          <div>
            <p className="font-serif text-3xl text-terracotta">88%</p>
            <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted">Days hit</p>
          </div>
        </div>

        <div className="mt-5 flex h-12 items-end gap-1.5">
          {[3, 5, 4, 7, 2, 6, 8, 4, 5, 7, 9, 6].map((v, i) => (
            <span
              key={i}
              className="flex-1 rounded-t-sm bg-terracotta/70"
              style={{ height: `${(v / 9) * 100}%` }}
            />
          ))}
        </div>
        <p className="mt-2 font-mono-accent text-[10px] text-muted">
          Words per entry, last 12 days
        </p>
      </div>
    </ShowcaseCard>
  )
}

const months = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']
const counts = [12, 18, 22, 14, 14, 0, 0, 0, 0, 0, 0, 0]

function YearlyOverviewMock() {
  return (
    <ShowcaseCard
      label="Year overview"
      title="The whole arc, in one grid."
      body="A 12-month view of how many entries you wrote — and which months you missed."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-5">
        <p className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">2026</p>
        <div className="mt-3 grid grid-cols-6 gap-2">
          {months.map((m, i) => {
            const v = counts[i]
            const intensity = v === 0 ? 0 : Math.min(1, v / 22)
            return (
              <div
                key={`${m}-${i}`}
                className={cn(
                  'rounded-md border border-border/40 px-2 py-2.5 text-center text-[11px]',
                  v === 0 ? 'bg-paper-alt/50 text-muted' : 'text-ink'
                )}
                style={
                  v === 0
                    ? undefined
                    : { backgroundColor: `rgba(255, 103, 26, ${0.08 + intensity * 0.35})` }
                }
              >
                <p className="font-mono-accent text-[10px] uppercase tracking-[0.18em] text-muted">
                  {m}
                </p>
                <p className="mt-1 font-serif text-lg">{v || '·'}</p>
              </div>
            )
          })}
        </div>
        <p className="mt-3 font-mono-accent text-[10px] text-muted">Entries per month</p>
      </div>
    </ShowcaseCard>
  )
}

function DayContextShowcase() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Context</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Today, in context.
            <br />
            <span className="italic text-terracotta">Before you write a word.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            The sidebar pulls in your calendar, your open tasks, and any notes you touched —
            grounding the entry before you start.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          <DayContextSidebarMock />
          <div className="grid gap-5">
            <FloatingDayPeekMock />
            <TemplatePickerMock />
          </div>
        </div>
      </Container>
    </section>
  )
}

function DayContextSidebarMock() {
  return (
    <motion.article
      {...fadeUp}
      className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-7 shadow-card md:p-9"
    >
      <Eyebrow>Day context sidebar</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">Everything happening today.</h3>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
        Schedule, tasks, and linked notes for the date you&apos;re writing about. Past days show the
        history. Future days show the plan.
      </p>

      <div className="mt-7 grid gap-5 md:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-paper-alt/50 p-5">
          <p className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
            Schedule · 3
          </p>
          <ul className="mt-3 space-y-3 text-[13px]">
            <li className="flex items-start gap-2.5">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-sage/15 text-sage">
                <Calendar className="h-3 w-3" strokeWidth={2} />
              </span>
              <div>
                <p className="text-ink/90">Morning walk</p>
                <p className="font-mono-accent text-[11px] text-muted">07:30 — 08:15</p>
              </div>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-sage/15 text-sage">
                <Calendar className="h-3 w-3" strokeWidth={2} />
              </span>
              <div>
                <p className="text-ink/90">Deep work — memrynote</p>
                <p className="font-mono-accent text-[11px] text-muted">10:00 — 12:30</p>
              </div>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-sage/15 text-sage">
                <Calendar className="h-3 w-3" strokeWidth={2} />
              </span>
              <div>
                <p className="text-ink/90">Dinner with M.</p>
                <p className="font-mono-accent text-[11px] text-muted">19:00</p>
              </div>
            </li>
          </ul>
        </div>

        <div className="rounded-xl border border-border/60 bg-paper-alt/50 p-5">
          <p className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
            Tasks for today · 2
          </p>
          <ul className="mt-3 space-y-2 text-[13px]">
            <li className="flex items-center gap-2.5 rounded-lg bg-card/70 px-3 py-2">
              <span className="h-1.5 w-1.5 rounded-full bg-terracotta" />
              <span className="text-ink/90">Ship journal page</span>
              <span className="ms-auto font-mono-accent text-[10px] text-muted">High</span>
            </li>
            <li className="flex items-center gap-2.5 rounded-lg bg-card/70 px-3 py-2">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              <span className="text-ink/90">Reply to V.</span>
              <span className="ms-auto font-mono-accent text-[10px] text-muted">Med</span>
            </li>
          </ul>

          <p className="mt-5 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
            Linked notes · 2
          </p>
          <ul className="mt-3 space-y-1.5 text-[13px]">
            <li className="text-terracotta">[[the-second-brain]]</li>
            <li className="text-terracotta">[[morning-routine]]</li>
          </ul>
        </div>
      </div>
    </motion.article>
  )
}

function FloatingDayPeekMock() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <Eyebrow>Floating day peek</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">Glance at the day next door.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Hover any adjacent day to peek at the entry — without losing your place.
      </p>
      <div className="mt-5 rounded-xl border border-border/60 bg-paper-alt/40 p-4">
        <div className="flex items-center justify-between text-[12px] text-muted">
          <span className="font-mono-accent uppercase tracking-[0.18em]">Yesterday</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </div>
        <p className="mt-2 font-serif text-base text-ink">Friday, May 15</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted line-clamp-2">
          Cleared inbox. Two open loops left. Tomorrow I want to start with the journal page before
          anything else.
        </p>
      </div>
    </motion.article>
  )
}

const templates = [
  { label: 'Morning pages', hint: '3 free-write prompts' },
  { label: 'Decision log', hint: 'Context · options · choice' },
  { label: 'Gratitude', hint: '3 things, 1 person' }
]

function TemplatePickerMock() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <Eyebrow>Templates</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">Pick your prompt. Start writing.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Pre-fill the day from a template you can edit. Or write from a blank page — your call.
      </p>
      <ul className="mt-5 space-y-2">
        {templates.map((t, i) => (
          <li
            key={t.label}
            className={cn(
              'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm',
              i === 0
                ? 'border-terracotta/30 bg-terracotta/8 text-terracotta'
                : 'border-border/60 bg-paper-alt/40 text-ink/85'
            )}
          >
            <span className="font-mono-accent">{t.label}</span>
            <span className="text-[11px] text-muted">{t.hint}</span>
          </li>
        ))}
      </ul>
    </motion.article>
  )
}

function ActivityHeatmapShowcase() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.2fr]">
          <motion.div {...fadeUp}>
            <Eyebrow>Activity heatmap</Eyebrow>
            <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
              See your habit,
              <br />
              <span className="italic text-terracotta">day by day.</span>
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
              A GitHub-style grid that shows every day of the year. Darker squares mean longer
              entries. Lighter squares show up too.
            </p>

            <div className="mt-7 inline-flex items-center gap-3 rounded-full border border-terracotta/30 bg-terracotta/8 px-4 py-2 text-terracotta">
              <Flame className="h-4 w-4" strokeWidth={2} />
              <span className="font-serif text-lg">117 days</span>
              <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-terracotta/80">
                current streak
              </span>
            </div>

            <div className="mt-6 flex flex-wrap gap-6 text-sm">
              <div>
                <p className="font-serif text-2xl text-ink">183</p>
                <p className="text-[11px] uppercase tracking-wide text-muted">Days written</p>
              </div>
              <div>
                <p className="font-serif text-2xl text-ink">42k</p>
                <p className="text-[11px] uppercase tracking-wide text-muted">Words this year</p>
              </div>
              <div>
                <p className="font-serif text-2xl text-ink">231</p>
                <p className="text-[11px] uppercase tracking-wide text-muted">Avg per entry</p>
              </div>
            </div>
          </motion.div>

          <motion.div
            {...fadeUp}
            transition={{ ...fadeUp.transition, delay: 0.1 }}
            className="rounded-2xl border border-border/60 bg-card p-6 shadow-card md:p-8"
          >
            <HeatmapGrid />
            <div className="mt-5 flex items-center justify-between text-[11px] text-muted">
              <span className="font-mono-accent uppercase tracking-[0.18em]">Last 12 weeks</span>
              <div className="flex items-center gap-2">
                <span>Less</span>
                {[0.1, 0.25, 0.45, 0.7, 0.95].map((a) => (
                  <span
                    key={a}
                    className="h-3 w-3 rounded-[3px] border border-border/50"
                    style={{ backgroundColor: `rgba(255, 103, 26, ${a})` }}
                  />
                ))}
                <span>More</span>
              </div>
            </div>
          </motion.div>
        </div>
      </Container>
    </section>
  )
}

const days = ['M', '', 'W', '', 'F', '', 'S']

function HeatmapGrid() {
  const weeks = 12
  const cells: number[] = []
  for (let i = 0; i < weeks * 7; i += 1) {
    const seed = (i * 9301 + 49297) % 233280
    const r = seed / 233280
    cells.push(r < 0.18 ? 0 : r)
  }
  return (
    <div className="flex gap-2">
      <div className="flex flex-col justify-between py-0.5 text-[10px] text-muted">
        {days.map((d, i) => (
          <span key={i} className="font-mono-accent leading-3">
            {d}
          </span>
        ))}
      </div>
      <div className="flex flex-1 gap-1.5">
        {Array.from({ length: weeks }).map((_, w) => (
          <div key={w} className="flex flex-1 flex-col gap-1.5">
            {Array.from({ length: 7 }).map((__, d) => {
              const v = cells[w * 7 + d]
              return (
                <span
                  key={d}
                  className="aspect-square rounded-[3px] border border-border/40"
                  style={{
                    backgroundColor:
                      v === 0 ? 'rgba(247,244,238,0.6)' : `rgba(255, 103, 26, ${0.12 + v * 0.7})`
                  }}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

const STRUCTURE_CARDS = [
  {
    icon: FileCode,
    title: 'Templates',
    body: 'Define your prompts once. Pre-fill every entry with the structure that fits the day.'
  },
  {
    icon: Calendar,
    title: 'Date navigation',
    body: 'Jump by calendar, month, or year overview. Past, present, future — all reachable.'
  },
  {
    icon: PanelLeft,
    title: 'Day context',
    body: 'Schedule, tasks, and notes for the date — surfaced beside the entry, never in the way.'
  },
  {
    icon: Bell,
    title: 'Journal reminders',
    body: 'Set a future reminder to revisit a specific entry. The past stays present.'
  },
  {
    icon: MessageSquare,
    title: 'Highlight reminders',
    body: 'Mark a passage. memrynote surfaces it back to you when the time is right.'
  },
  {
    icon: Clock,
    title: 'Time-based greetings',
    body: 'The page knows the hour. A small touch that makes the ritual feel personal.'
  }
] as const

function StructureRitual() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Structure</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            A ritual that holds up.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            From a one-line check-in to a structured morning practice — the journal scales with how
            much you want to put in.
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
    icon: Inbox,
    title: 'From Inbox',
    body: 'Capture during the day, reflect at night. Source links from clips and quick captures hold.'
  },
  {
    icon: Calendar,
    title: 'With Calendar',
    body: "Today's schedule shows up beside the entry. Past days keep their plan, too."
  },
  {
    icon: CheckSquare,
    title: 'With Tasks',
    body: 'See what was due today, what you finished, and what slipped — without leaving the page.'
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
            The journal isn&apos;t a separate app. It reads from your inbox, your calendar, your
            tasks, and the notes you keep returning to.
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
    icon: PenTool,
    title: 'Writers',
    body: 'Morning pages, three pages a day. Templates hold the form so you can find the words.'
  },
  {
    icon: Target,
    title: 'Founders',
    body: 'Decision log every evening. Context now, hindsight later — searchable in plain markdown.'
  },
  {
    icon: BookOpen,
    title: 'Students',
    body: 'Daily study log. What you read, what stuck, what to revisit. Linked to the source notes.'
  },
  {
    icon: Heart,
    title: 'Personal',
    body: 'Gratitude, mood, three good things. A small ritual that adds up over the year.'
  }
] as const

function JournalUseCases() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Use cases</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for the writing you keep coming back to.
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

const MORE_FEATURES = [
  { icon: Bell, title: 'Journal reminders', body: 'Schedule a future revisit on any entry.' },
  {
    icon: MessageSquare,
    title: 'Highlight callbacks',
    body: 'Mark a sentence. memrynote brings it back to you.'
  },
  {
    icon: Layers,
    title: 'Year overview',
    body: 'A 12-month grid of entries, words, and patterns.'
  },
  {
    icon: Sparkles,
    title: 'Monthly stats',
    body: 'Entry count, word count, average activity per month.'
  },
  {
    icon: FileCode,
    title: 'Custom templates',
    body: 'Save your own prompts. Switch per day.'
  },
  {
    icon: ChevronRight,
    title: 'Floating day peek',
    body: 'Glance at the entry next door without losing focus.'
  }
] as const

function MoreJournalFeatures() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>And more</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            A few more touches.
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
                <p className="font-serif text-base text-ink">{m.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">{m.body}</p>
              </div>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const JOURNAL_FAQ = [
  {
    question: 'Where are journal entries stored?',
    answer:
      'Every entry is a plain .md file inside your vault folder, named by date (for example 2026-05-16.md). Open them in any markdown editor, back them up however you like — they belong to you.'
  },
  {
    question: 'Can I write entries for past dates?',
    answer:
      'Yes. Use the date navigator to jump to any day — past or future. Past days keep their original schedule and tasks in the sidebar, so the context still makes sense when you backfill.'
  },
  {
    question: 'Are entries encrypted?',
    answer:
      'On disk they sit as plain markdown in your vault. When you sync across your own devices, payloads are end-to-end encrypted with XChaCha20-Poly1305 — the server never sees plaintext.'
  },
  {
    question: 'What shows up in the day context sidebar?',
    answer:
      'Calendar events for the date, tasks due or completed that day, and notes you referenced or edited. Past days show the history; future days show the plan.'
  },
  {
    question: 'Can I export my entries?',
    answer:
      'You already have them — every entry is a .md file in your vault folder. Export to PDF for a single day, or zip the whole journal folder. No lock-in.'
  }
]

function JournalFaq() {
  return (
    <section className="border-t border-border/40 bg-paper-alt/35 py-24">
      <Container size="sm">
        <motion.div {...fadeUp} className="mb-12 text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-4xl">
            Journal, answered.
          </h2>
        </motion.div>

        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <Accordion type="single" collapsible className="w-full">
            {JOURNAL_FAQ.map((item, i) => (
              <AccordionItem
                key={item.question}
                value={`journal-faq-${i}`}
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

function JournalFinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_55%)]"
      />
      <Container size="md">
        <motion.div {...fadeUp} className="text-center">
          <h2 className="mx-auto max-w-2xl font-serif text-4xl font-normal leading-tight text-ink text-balance md:text-5xl">
            A ritual, <span className="italic text-terracotta">not a chore.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Local-first. End-to-end encrypted. Plain markdown files in a folder you own — one per
            day, for as long as you keep showing up.
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
