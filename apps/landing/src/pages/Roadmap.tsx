import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { GITHUB_URL } from '@/lib/constants'

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } }
}

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT_EXPO } }
}

type StatusTone = 'sage' | 'terracotta' | 'muted'

interface RoadmapItem {
  title: string
  caption?: string
}

interface LaunchedGroup {
  period: string
  items: RoadmapItem[]
}

const ACTIVE_ITEMS: RoadmapItem[] = [
  {
    title: 'Web clipper',
    caption: 'Save pages, highlights, and snippets straight into your Inbox from any browser.'
  },
  {
    title: 'Importers',
    caption: 'Bring your knowledge base over from Obsidian, Notion, Roam, or any Markdown folder.'
  },
  {
    title: 'AI Agent public release polish',
    caption:
      'Stable provider settings, smoother streaming, and approval-gated writes for everyday use.'
  }
]

const PLANNED_ITEMS: RoadmapItem[] = [
  {
    title: 'Mobile apps — iOS and Android',
    caption: 'Capture, triage, and read on the go. Targeting late 2026.'
  },
  {
    title: 'Public and shared vaults',
    caption: 'Publish notes to the web or collaborate on a shared workspace.'
  },
  {
    title: 'Plugin API',
    caption: 'Extend Memry with your own tools, integrations, and views.'
  },
  {
    title: 'Templates marketplace',
    caption: 'Share and discover note, task, and journal templates.'
  },
  {
    title: 'Self-hosted sync server',
    caption: 'Run the encrypted sync layer on your own infrastructure.'
  }
]

const LAUNCHED_GROUPS: LaunchedGroup[] = [
  {
    period: 'May 2026',
    items: [
      {
        title: 'Agent Chat: per-turn permissions',
        caption: 'Vault-only, computer access, and web search controls in the composer.'
      },
      { title: 'Agent Chat: inline mention tags for notes, tasks, journals, inbox, and calendar' },
      { title: 'Agent inbox snooze write tool' },
      {
        title: 'Voice memos with transcription and related items',
        caption: 'Inline recorder, transcript previews, and audio-aware mention picker.'
      },
      { title: 'Landing demo refresh, founder story, and event analytics' }
    ]
  },
  {
    period: 'April 2026',
    items: [
      {
        title: 'Multi-language support',
        caption: 'English, Turkish, and Arabic — full RTL layout, ICU plurals, localized menus.'
      },
      { title: 'Calendar week view with infinite horizontal scroll' },
      { title: 'Google Calendar sync triggers and OAuth diagnostics' },
      { title: 'Calendar inbox-snooze chips with open / unsnooze / reschedule actions' },
      { title: 'Vim hint mode' },
      { title: 'Inline subtasks and inline task blocks in notes' },
      { title: 'Inbox redesign with triage, snooze, and folder creation' },
      { title: 'Sync adapter registry and architecture reset' }
    ]
  },
  {
    period: 'March 2026',
    items: [
      { title: 'White theme and settings panel polish' },
      { title: 'Inline AI editing in the editor' },
      { title: 'Graph view' },
      { title: 'Global search' },
      { title: 'Journal redesign with day context and templates' },
      { title: 'Note page with link autocomplete and embeds' }
    ]
  },
  {
    period: 'February 2026',
    items: [
      {
        title: 'End-to-end encrypted sync',
        caption:
          'XChaCha20-Poly1305, Ed25519, and Argon2id via libsodium. Server never sees plaintext.'
      },
      { title: 'CRDT sync for notes and journals (Yjs)' },
      { title: 'Field-level vector clocks for tasks and projects' },
      { title: 'Memry CLI' }
    ]
  }
]

const TONE_CLASSES: Record<StatusTone, string> = {
  sage: 'bg-sage/10 text-sage border-sage/30',
  terracotta: 'bg-terracotta/10 text-terracotta border-terracotta/30',
  muted: 'bg-ink/5 text-muted border-border'
}

function StatusPill({ label, tone, count }: { label: string; tone: StatusTone; count: number }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono-accent text-[11px] uppercase tracking-[0.18em] ${TONE_CLASSES[tone]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
      <span className="opacity-60">· {count}</span>
    </span>
  )
}

function RoadmapRow({ item }: { item: RoadmapItem }) {
  return (
    <motion.li
      variants={fadeUp}
      className="flex flex-col gap-1 border-b border-border/60 py-4 last:border-b-0"
    >
      <span className="font-serif text-lg text-ink leading-snug">{item.title}</span>
      {item.caption && <span className="text-sm text-muted leading-relaxed">{item.caption}</span>}
    </motion.li>
  )
}

function RoadmapList({ items }: { items: RoadmapItem[] }) {
  return (
    <motion.ul
      variants={stagger}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-60px' }}
      className="border-t border-border/60"
    >
      {items.map((item) => (
        <RoadmapRow key={item.title} item={item} />
      ))}
    </motion.ul>
  )
}

const TOTAL_LAUNCHED = LAUNCHED_GROUPS.reduce((sum, group) => sum + group.items.length, 0)

export function RoadmapPage() {
  return (
    <main className="pt-32 pb-24 md:pt-40">
      <PageHead page="roadmap" />
      <Container size="md">
        <section className="border-b border-border pb-12">
          <p className="font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta">
            Building in public
          </p>
          <h1 className="mt-4 font-serif text-5xl leading-[1.05] text-ink md:text-6xl">Roadmap</h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">
            What is available, what is active, and what is planned next. This is direction, not a
            release promise.
          </p>
          <div className="mt-8 flex flex-wrap gap-3 text-sm">
            <a
              href={`${GITHUB_URL}/releases`}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 font-medium text-ink transition-colors hover:border-terracotta/30 hover:text-terracotta"
            >
              Changelog
              <ArrowRight className="h-4 w-4" aria-hidden />
            </a>
            <a
              href={`${GITHUB_URL}/issues`}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 font-medium text-ink transition-colors hover:border-terracotta/30 hover:text-terracotta"
            >
              Request a feature
              <ArrowRight className="h-4 w-4" aria-hidden />
            </a>
          </div>
        </section>

        <section className="border-b border-border py-12">
          <div className="mb-6">
            <StatusPill label="Active" tone="sage" count={ACTIVE_ITEMS.length} />
          </div>
          <RoadmapList items={ACTIVE_ITEMS} />
        </section>

        <section className="border-b border-border py-12">
          <div className="mb-6">
            <StatusPill label="Planned" tone="terracotta" count={PLANNED_ITEMS.length} />
          </div>
          <RoadmapList items={PLANNED_ITEMS} />
        </section>

        <section className="pt-12">
          <div className="mb-6">
            <StatusPill label="Launched" tone="muted" count={TOTAL_LAUNCHED} />
          </div>

          <motion.div
            variants={stagger}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: '-60px' }}
            className="space-y-10"
          >
            {LAUNCHED_GROUPS.map((group) => (
              <div
                key={group.period}
                className="grid grid-cols-1 gap-3 md:grid-cols-[140px_1fr] md:gap-10"
              >
                <h3 className="font-mono-accent text-xs uppercase tracking-[0.18em] text-muted md:pt-5">
                  {group.period}
                </h3>
                <ul className="border-t border-border/60">
                  {group.items.map((item) => (
                    <RoadmapRow key={item.title} item={item} />
                  ))}
                </ul>
              </div>
            ))}
          </motion.div>
        </section>
      </Container>
    </main>
  )
}
