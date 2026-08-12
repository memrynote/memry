import { Link } from 'react-router'
import { motion } from 'motion/react'
import {
  ArrowRight,
  ArrowUpDown,
  ArrowUpRight,
  Bookmark,
  Briefcase,
  Calendar,
  Check,
  Clock,
  Filter,
  FolderOpen,
  GitBranch,
  GraduationCap,
  Hash,
  Heart,
  Layers,
  Link2,
  ListChecks,
  PenTool,
  RotateCcw,
  Sparkles,
  ToggleLeft,
  Zap,
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

export function TasksFeaturePage() {
  return (
    <>
      <PageHead page="tasks" />
      <main>
        <TasksHero />
        <EverythingInOnePlace />
        <ViewsShowcase />
        <TaskDetailShowcase />
        <QuickAddShowcase />
        <StructureSection />
        <WorksWithRest />
        <TasksUseCases />
        <MoreTaskFeatures />
        <TasksFaq />
        <TasksFinalCta />
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

function TasksHero() {
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
          <Eyebrow>Tasks</Eyebrow>
          <h1 className="mt-4 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
            From thought to <span className="italic text-terracotta">done.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            A multi-dimensional task system. Projects, custom statuses, recurring schedules. Kanban,
            calendar, list. Pick the view that fits your work.
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
          <HeroKanbanMock />
        </motion.div>
      </Container>
    </section>
  )
}

function HeroKanbanMock() {
  return (
    <FeatureHeroScreenshot
      screenshot="tasks"
      alt="memrynote tasks page showing grouped priorities, a selected task, and the task detail drawer"
      width={1608}
      height={944}
    />
  )
}

const ANCHOR_CARDS = [
  {
    icon: FolderOpen,
    title: 'Projects',
    body: 'Group tasks into projects with custom colors and icons. Each project keeps its own workflow.'
  },
  {
    icon: ToggleLeft,
    title: 'Custom statuses',
    body: 'Define unique statuses per project. Match your workflow instead of bending to a template.'
  },
  {
    icon: GitBranch,
    title: 'Subtasks',
    body: 'Break work down with nested subtasks. Progress rolls up to the parent automatically.'
  },
  {
    icon: RotateCcw,
    title: 'Recurring schedules',
    body: 'Daily, weekly, monthly, yearly. Flexible frequency for habits, reviews, and rituals.'
  }
] as const

function EverythingInOnePlace() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>One system, every angle</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            A task system with shape.
            <br />
            Not just a flat list.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Projects hold the work. Statuses move it forward. Subtasks track the steps. Recurring
            schedules carry the habit.
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
          <Eyebrow>Views</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Three views, one truth.
            <br />
            <span className="italic text-terracotta">Switch with a keystroke.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Same tasks. Different lens. Kanban for momentum, calendar for time, list for focus.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          <KanbanViewCard />
          <CalendarViewCard />
          <ListViewCard />
        </div>
      </Container>
    </section>
  )
}

function ViewCard({
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

const KANBAN_COLS = [
  { label: 'To do', count: 4, active: false },
  { label: 'Doing', count: 2, active: true },
  { label: 'Done', count: 7, active: false }
]

function KanbanViewCard() {
  return (
    <ViewCard
      label="Kanban"
      title="Drag the work forward."
      body="Columns by status. Drop a card to move it. Custom columns per project."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-3">
        <div className="grid grid-cols-3 gap-2">
          {KANBAN_COLS.map((col) => (
            <div
              key={col.label}
              className={cn(
                'rounded-lg px-2 py-2',
                col.active ? 'bg-terracotta/10' : 'bg-paper-alt/60'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono-accent text-[10px] uppercase tracking-[0.16em] text-muted">
                  {col.label}
                </span>
                <span className="font-mono-accent text-[10px] text-muted">{col.count}</span>
              </div>
              <div className="mt-2 space-y-1.5">
                <div className="h-6 rounded-md bg-card border border-border/50" />
                {col.active && (
                  <div className="h-6 rounded-md bg-card border border-terracotta/40 rotate-[-1deg] shadow-card" />
                )}
                <div className="h-6 rounded-md bg-card border border-border/50" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </ViewCard>
  )
}

const CALENDAR_DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

const CALENDAR_TASKS: Record<number, { tone: 'terracotta' | 'sage' | 'amber'; label: string }[]> = {
  1: [{ tone: 'terracotta', label: 'Spec' }],
  3: [{ tone: 'sage', label: 'Standup' }],
  5: [
    { tone: 'amber', label: 'Review' },
    { tone: 'terracotta', label: 'Demo' }
  ],
  9: [{ tone: 'sage', label: 'Retro' }],
  11: [{ tone: 'terracotta', label: 'Ship' }]
}

const CALENDAR_TONE_CLASS: Record<'terracotta' | 'sage' | 'amber', string> = {
  terracotta: 'bg-terracotta/15 text-terracotta',
  sage: 'bg-sage/15 text-sage',
  amber: 'bg-amber-500/15 text-amber-700'
}

function CalendarViewCard() {
  const cells = Array.from({ length: 14 })
  return (
    <ViewCard
      label="Calendar"
      title="Plot it on the week."
      body="Tasks land on their due dates. Drag to reschedule. See the load at a glance."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-3">
        <div className="grid grid-cols-7 gap-1 pb-2">
          {CALENDAR_DAYS.map((d, i) => (
            <span
              key={i}
              className="text-center font-mono-accent text-[10px] uppercase tracking-[0.18em] text-muted"
            >
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((_, i) => (
            <div
              key={i}
              className="aspect-square rounded-md border border-border/40 bg-paper-alt/40 p-1"
            >
              <div className="text-[9px] text-muted/60">{i + 1}</div>
              <div className="mt-0.5 space-y-0.5">
                {(CALENDAR_TASKS[i] ?? []).map((t, j) => (
                  <div
                    key={j}
                    className={cn(
                      'truncate rounded px-1 py-0.5 font-mono-accent text-[8px]',
                      CALENDAR_TONE_CLASS[t.tone]
                    )}
                  >
                    {t.label}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ViewCard>
  )
}

const LIST_ROWS = [
  { title: 'Draft Q3 launch plan', priority: 'high', due: 'Mon', done: false },
  { title: 'Wire calendar drag-drop', priority: 'urgent', due: 'Today', done: false },
  { title: 'Review onboarding copy', priority: 'medium', due: 'Wed', done: false },
  { title: 'Ship sync engine', priority: 'medium', due: 'Yesterday', done: true }
] as const

const LIST_DOT: Record<(typeof LIST_ROWS)[number]['priority'], string> = {
  urgent: 'bg-terracotta',
  high: 'bg-amber-500',
  medium: 'bg-sage'
}

function ListViewCard() {
  return (
    <ViewCard
      label="List"
      title="Stay close to the queue."
      body="Group by project, status, or date. Sort by priority. Keyboard-first."
    >
      <div className="overflow-hidden rounded-xl border border-border/60 bg-paper">
        <ul className="divide-y divide-border/40">
          {LIST_ROWS.map((row) => (
            <li key={row.title} className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
              <span
                className={cn(
                  'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border',
                  row.done ? 'border-terracotta bg-terracotta' : 'border-ink/25'
                )}
              >
                {row.done && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
              </span>
              <span className={cn('h-2 w-2 shrink-0 rounded-full', LIST_DOT[row.priority])} />
              <span className={cn('flex-1 truncate', row.done && 'text-ink/45 line-through')}>
                {row.title}
              </span>
              <span className="font-mono-accent text-[10px] text-muted">{row.due}</span>
            </li>
          ))}
        </ul>
      </div>
    </ViewCard>
  )
}

function TaskDetailShowcase() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Task detail</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Every task has context.
            <br />
            <span className="italic text-terracotta">And a way to slice it.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Subtasks, priority, due dates, project tag, task tags. Smart filters and saved presets
            pull the right view in one click.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          <TaskDetailCard />
          <div className="grid gap-5">
            <SmartFiltersCard />
            <SavedPresetsCard />
          </div>
        </div>
      </Container>
    </section>
  )
}

const TASK_DETAIL_SUBTASKS: { title: string; done: boolean }[] = [
  { title: 'Outline the spec', done: true },
  { title: 'Wire the API endpoints', done: true },
  { title: 'Build the renderer', done: false }
]

function TaskDetailCard() {
  const completed = TASK_DETAIL_SUBTASKS.filter((s) => s.done).length
  return (
    <motion.article
      {...fadeUp}
      className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-7 shadow-card md:p-9"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-terracotta/12 px-2.5 py-1 font-mono-accent text-[10px] uppercase tracking-[0.16em] text-terracotta">
          <span className="h-1.5 w-1.5 rounded-full bg-terracotta" />
          Urgent
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-paper-alt px-2.5 py-1 font-mono-accent text-[10px] uppercase tracking-[0.16em] text-ink/70">
          <Calendar className="h-3 w-3" strokeWidth={1.8} />
          Due today, 5pm
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-terracotta/10 px-2.5 py-1 font-mono-accent text-[10px] text-terracotta">
          <FolderOpen className="h-3 w-3" strokeWidth={1.8} />
          Launch
        </span>
      </div>

      <h3 className="mt-5 font-serif text-2xl text-ink md:text-3xl">
        Wire calendar drag-drop rescheduling
      </h3>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
        Pointer-down handler should fire before the disabled state applies. Add optimistic update,
        rollback on failure. Linked to <span className="text-terracotta">[[calendar-spec]]</span>.
      </p>

      <div className="mt-6 rounded-xl border border-border/60 bg-paper-alt/50 p-5">
        <div className="flex items-center justify-between">
          <span className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
            Subtasks · {completed} of {TASK_DETAIL_SUBTASKS.length}
          </span>
          <span className="font-mono-accent text-[11px] text-terracotta">
            {Math.round((completed / TASK_DETAIL_SUBTASKS.length) * 100)}%
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-paper">
          <div
            className="h-full rounded-full bg-terracotta"
            style={{ width: `${(completed / TASK_DETAIL_SUBTASKS.length) * 100}%` }}
          />
        </div>
        <ul className="mt-4 space-y-2">
          {TASK_DETAIL_SUBTASKS.map((s) => (
            <li key={s.title} className="flex items-start gap-2.5 text-[14px]">
              <span
                className={cn(
                  'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border',
                  s.done ? 'border-terracotta bg-terracotta' : 'border-ink/25'
                )}
              >
                {s.done && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
              </span>
              <span className={cn(s.done ? 'text-ink/55 line-through' : 'text-ink/85')}>
                {s.title}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {['#frontend', '#calendar', '#blocker'].map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center rounded-full border border-terracotta/30 bg-terracotta/8 px-2.5 py-1 font-mono-accent text-[11px] text-terracotta"
          >
            {tag}
          </span>
        ))}
      </div>
    </motion.article>
  )
}

const SMART_FILTERS: {
  label: string
  tone: 'terracotta' | 'sage' | 'amber' | 'ink'
  active?: boolean
}[] = [
  { label: 'priority: urgent', tone: 'terracotta', active: true },
  { label: 'project: launch', tone: 'terracotta' },
  { label: 'due: this week', tone: 'amber', active: true },
  { label: 'status: doing', tone: 'sage' },
  { label: 'tag: #blocker', tone: 'terracotta' },
  { label: 'no project', tone: 'ink' }
]

const SMART_FILTERS_TONE_CLASS: Record<'terracotta' | 'sage' | 'amber' | 'ink', string> = {
  terracotta: 'border-terracotta/30 bg-terracotta/8 text-terracotta',
  sage: 'border-sage/30 bg-sage/10 text-sage',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700',
  ink: 'border-border/60 bg-paper-alt/60 text-ink/70'
}

function SmartFiltersCard() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <Eyebrow>Smart filters</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">Slice by anything.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Combine priority, project, status, dates, and tags. Stack as many as you need.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {SMART_FILTERS.map((f) => (
          <span
            key={f.label}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-accent text-[11px]',
              SMART_FILTERS_TONE_CLASS[f.tone],
              f.active && 'ring-1 ring-current'
            )}
          >
            {f.active && <Check className="h-3 w-3" strokeWidth={3} />}
            {f.label}
          </span>
        ))}
      </div>
    </motion.article>
  )
}

const SAVED_PRESETS = [
  { title: 'Today, urgent', count: 3, tone: 'terracotta' as const },
  { title: 'This week, launch', count: 12, tone: 'sage' as const },
  { title: 'Blocked', count: 4, tone: 'amber' as const },
  { title: 'No due date', count: 27, tone: 'terracotta' as const }
]

const SAVED_PRESETS_DOT: Record<(typeof SAVED_PRESETS)[number]['tone'], string> = {
  terracotta: 'bg-terracotta',
  sage: 'bg-sage',
  amber: 'bg-amber-500'
}

function SavedPresetsCard() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <Eyebrow>Saved presets</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">One click. Back to the view.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Pin your favorite filter combinations. They live in the sidebar, ready when you are.
      </p>
      <ul className="mt-5 space-y-2">
        {SAVED_PRESETS.map((p) => (
          <li
            key={p.title}
            className="flex items-center justify-between rounded-lg border border-border/50 bg-paper-alt/40 px-3 py-2.5 text-[13px]"
          >
            <span className="flex items-center gap-2.5">
              <span className={cn('h-2 w-2 rounded-full', SAVED_PRESETS_DOT[p.tone])} />
              <span className="text-ink/85">{p.title}</span>
            </span>
            <span className="font-mono-accent text-[11px] text-muted">{p.count}</span>
          </li>
        ))}
      </ul>
    </motion.article>
  )
}

const QUICK_ADD_CHIPS: { icon: LucideIcon; label: string }[] = [
  { icon: ArrowUpDown, label: '5 priority levels' },
  { icon: Calendar, label: 'Dates & times' },
  { icon: Hash, label: 'Tags' },
  { icon: FolderOpen, label: 'Projects' },
  { icon: RotateCcw, label: 'Recurrence' }
]

function QuickAddShowcase() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.2fr]">
          <motion.div {...fadeUp}>
            <Eyebrow>Quick add</Eyebrow>
            <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
              From thought to task
              <br />
              <span className="italic text-terracotta">in one keystroke.</span>
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
              Hit the shortcut. Type the task. memrynote parses dates, priority, project, and tags
              from plain English. No forms. No tabbing through fields.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {QUICK_ADD_CHIPS.map((chip) => (
                <span
                  key={chip.label}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm text-ink/85 shadow-sm"
                >
                  <chip.icon className="h-3.5 w-3.5 text-terracotta" strokeWidth={1.8} />
                  {chip.label}
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
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-terracotta/10 text-terracotta">
                <Zap className="h-3.5 w-3.5" strokeWidth={1.8} />
              </span>
              <span className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
                Quick add · ⌘N
              </span>
            </div>
            <div className="mt-5 rounded-xl border border-border/70 bg-paper-alt/50 px-4 py-4">
              <p className="text-[15px] leading-relaxed text-ink/85">
                Review onboarding copy{' '}
                <span className="rounded bg-terracotta/15 px-1.5 py-0.5 font-mono-accent text-[13px] text-terracotta">
                  tomorrow 3pm
                </span>{' '}
                <span className="rounded bg-sage/15 px-1.5 py-0.5 font-mono-accent text-[13px] text-sage">
                  !high
                </span>{' '}
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono-accent text-[13px] text-amber-700">
                  +marketing
                </span>{' '}
                <span className="rounded bg-terracotta/10 px-1.5 py-0.5 font-mono-accent text-[13px] text-terracotta">
                  #copy
                </span>
                <span className="inline-block h-5 w-px translate-y-0.5 bg-terracotta align-middle motion-safe:animate-pulse" />
              </p>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 text-[12px]">
              <ParsedRow label="Due" value="Wed, May 17 · 3:00 PM" tone="terracotta" />
              <ParsedRow label="Priority" value="High" tone="sage" />
              <ParsedRow label="Project" value="Marketing" tone="amber" />
              <ParsedRow label="Tag" value="#copy" tone="terracotta" />
            </div>
            <p className="mt-5 rounded-lg bg-paper-alt/60 px-3 py-2 font-mono-accent text-[11px] text-muted">
              Press enter. The task lands in the right project, on the right day.
            </p>
          </motion.div>
        </div>
      </Container>
    </section>
  )
}

const PARSED_ROW_DOT: Record<'terracotta' | 'sage' | 'amber', string> = {
  terracotta: 'bg-terracotta',
  sage: 'bg-sage',
  amber: 'bg-amber-500'
}

function ParsedRow({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone: 'terracotta' | 'sage' | 'amber'
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-paper-alt/40 px-3 py-2">
      <span className={cn('h-1.5 w-1.5 rounded-full', PARSED_ROW_DOT[tone])} />
      <span className="font-mono-accent text-[10px] uppercase tracking-[0.16em] text-muted">
        {label}
      </span>
      <span className="ms-auto text-ink/85">{value}</span>
    </div>
  )
}

const STRUCTURE_CARDS = [
  {
    icon: ArrowUpDown,
    title: '5-level priority',
    body: 'None, low, medium, high, urgent. Sort and filter by what matters most right now.'
  },
  {
    icon: Calendar,
    title: 'Due & start dates',
    body: 'Deadlines plus optional start dates. Time granularity for hour-specific blocks.'
  },
  {
    icon: Clock,
    title: 'Today & Upcoming',
    body: 'Two built-in views. What you owe today. What is coming next.'
  },
  {
    icon: Filter,
    title: 'Smart filters',
    body: 'Stack filters by priority, project, status, dates, and tags. Combine freely.'
  },
  {
    icon: Bookmark,
    title: 'Saved presets',
    body: 'Pin filter combinations to the sidebar. One click reloads the view.'
  },
  {
    icon: Layers,
    title: 'Bulk actions',
    body: 'Multi-select tasks. Reassign project, shift due date, change status in one move.'
  }
] as const

function StructureSection() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Structure</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Shape work the way you think.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Priority, dates, filters, presets. The bones of a task system that grows with you.
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
    icon: ListChecks,
    title: 'From Notes',
    body: 'Inline checkboxes inside any note become real tasks. Same source of truth, both ways.'
  },
  {
    icon: PenTool,
    title: 'In Journal',
    body: "Today's tasks surface in the daily entry. Reflect on what you shipped without leaving the page."
  },
  {
    icon: Calendar,
    title: 'On Calendar',
    body: 'Tasks plot by due date inside memrynote. Drag to reschedule across the week.'
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
            Tasks live next to your notes and journal. Same vault, same shortcuts, same backlinks.
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
    title: 'Founders',
    body: 'Bounce between shipping, hiring, fundraising. Projects keep each thread isolated.'
  },
  {
    icon: PenTool,
    title: 'Freelancers',
    body: 'One project per client. Custom statuses match each engagement. Recurring invoices ship on time.'
  },
  {
    icon: GraduationCap,
    title: 'Students',
    body: 'Courses as projects. Assignments as subtasks. Calendar view shows the week before it crushes you.'
  },
  {
    icon: Heart,
    title: 'Personal productivity',
    body: 'Habits, errands, reading queue. Recurring schedules carry the rituals you want to keep.'
  }
] as const

function TasksUseCases() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Use cases</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for people who ship.
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
  {
    icon: Zap,
    title: 'Natural-language quick add',
    body: '"Tomorrow 3pm !high +marketing #copy" parses on enter.'
  },
  {
    icon: Sparkles,
    title: 'Completion celebration',
    body: 'A small animation when you check things off. Earned.'
  },
  { icon: RotateCcw, title: 'Undo', body: 'Closed by accident? Cmd+Z brings it back.' },
  {
    icon: FolderOpen,
    title: 'Archive',
    body: 'Sweep finished work out of the way without deleting.'
  },
  {
    icon: Hash,
    title: 'Task tags',
    body: 'Tag across projects so cross-cutting work stays findable.'
  },
  { icon: Link2, title: 'Task-note linking', body: 'Attach a note to any task for full context.' }
] as const

function MoreTaskFeatures() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>And more</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Wait. There&apos;s more.
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

const TASKS_FAQ = [
  {
    question: 'Can I move tasks between projects?',
    answer:
      'Yes. Drag a task to a different project in the sidebar, or use bulk actions to reassign many at once. Custom statuses re-map to the new project, and links to notes stay intact.'
  },
  {
    question: 'Do recurring tasks support custom intervals?',
    answer:
      'Daily, weekly, monthly, and yearly are first-class. Flexible frequency control lets you pick the cadence: every weekday, every two weeks, the first Monday of the month. The next instance shows up only when the previous one is closed.'
  },
  {
    question: 'How do subtasks work?',
    answer:
      'Break any task into nested subtasks. Progress on the parent rolls up automatically as you check each one off. Subtasks carry their own due dates and can stay inside the parent or pop into the main list.'
  },
  {
    question: 'Can I have tasks without projects?',
    answer:
      'Yes. A task does not need a project. The sidebar has a top-level inbox for floating work. Filter by "no project" any time to find tasks waiting for a home.'
  },
  {
    question: 'Is there a "today" view?',
    answer:
      'Today and Upcoming are built in. Today pulls everything due now plus overdue. Upcoming spans the next seven days, grouped by date so you can scan the week.'
  }
]

function TasksFaq() {
  return (
    <section className="border-t border-border/40 bg-paper-alt/35 py-24">
      <Container size="sm">
        <motion.div {...fadeUp} className="mb-12 text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-4xl">
            Tasks, answered.
          </h2>
        </motion.div>

        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <Accordion type="single" collapsible className="w-full">
            {TASKS_FAQ.map((item, i) => (
              <AccordionItem
                key={item.question}
                value={`tasks-faq-${i}`}
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

function TasksFinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_55%)]"
      />
      <Container size="md">
        <motion.div {...fadeUp} className="text-center">
          <h2 className="mx-auto max-w-2xl font-serif text-4xl font-normal leading-tight text-ink text-balance md:text-5xl">
            From thought to done.{' '}
            <span className="italic text-terracotta">In whatever view fits.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Projects, statuses, subtasks, recurrence. Kanban, calendar, list. Local-first. Yours.
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
