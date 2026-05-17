import { motion } from 'framer-motion'
import { ArrowUpRight, Map } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { CHANGELOG_URL, GITHUB_URL } from '@/lib/constants'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

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
    <main className="pt-24">
      <PageHead page="roadmap" />

      <section className="py-20">
        <Container size="md">
          <motion.div
            initial={BLUR_REVEAL_INITIAL}
            animate={BLUR_REVEAL_ANIMATE}
            transition={BLUR_REVEAL_TRANSITION}
            className="text-center"
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-terracotta/30 bg-terracotta/5 text-terracotta text-sm font-medium mb-8">
              <Map className="w-4 h-4" />
              Roadmap
            </div>
            <h1 className="font-serif text-5xl md:text-6xl lg:text-7xl text-ink mb-6 leading-[1.1]">
              What we&apos;re building,
              <br />
              <span className="text-terracotta">in the open.</span>
            </h1>
            <p className="text-xl text-muted font-sans max-w-2xl mx-auto leading-relaxed mb-6">
              What is shipping now, what is planned next, and what we have already launched. This
              page updates as we ship.
            </p>
            <a
              href={CHANGELOG_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-ink/80 hover:text-terracotta transition-colors"
            >
              See full changelog
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          </motion.div>
        </Container>
      </section>

      <section className="py-12">
        <Container size="md">
          <div className="mb-6">
            <StatusPill label="Active" tone="sage" count={ACTIVE_ITEMS.length} />
          </div>
          <RoadmapList items={ACTIVE_ITEMS} />
        </Container>
      </section>

      <section className="py-12 bg-paper-alt">
        <Container size="md">
          <div className="mb-6">
            <StatusPill label="Planned" tone="terracotta" count={PLANNED_ITEMS.length} />
          </div>
          <RoadmapList items={PLANNED_ITEMS} />
        </Container>
      </section>

      <section className="py-12">
        <Container size="md">
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
              <div key={group.period}>
                <h3 className="font-mono-accent text-xs uppercase tracking-[0.18em] text-muted mb-3">
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
        </Container>
      </section>

      <section className="py-24">
        <Container size="sm">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
            className="text-center"
          >
            <h2 className="font-serif text-3xl text-ink mb-4">Have an idea?</h2>
            <p className="text-lg text-muted mb-8 max-w-lg mx-auto leading-relaxed">
              Open an issue on GitHub or send us a note — we read everything.
            </p>
            <a
              href={`${GITHUB_URL}/issues`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-ink text-paper font-medium text-sm hover:bg-ink/90 transition-colors"
            >
              Open an issue
              <ArrowUpRight className="w-4 h-4" />
            </a>
          </motion.div>
        </Container>
      </section>
    </main>
  )
}
