import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { PageHero } from '@/components/site/PageHero'
import { FeatureChip } from '@/components/site/primitives'
import { GITHUB_URL } from '@/lib/constants'
import { SITE_TINTS } from '@/lib/site-tints'

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
    title: 'Safari web clipper',
    caption:
      'Extend page, highlight, and snippet clipping to Safari alongside Chrome, Firefox, and Edge.'
  },
  {
    title: 'Edge Add-ons store listing',
    caption:
      'Publish the clipper to the Edge Add-ons store — Chrome Web Store and Firefox Add-ons are already live.'
  },
  {
    title: 'Optional AI Agent public release polish',
    caption:
      'Stable on/off controls, provider settings, smoother streaming, and approval-gated writes for everyday use.'
  }
]

const PLANNED_ITEMS: RoadmapItem[] = [
  {
    title: 'Mobile apps — iPhone, iPad, and Android',
    caption:
      'Quick capture on phones plus an iPad-optimized writing and reading surface. Targeting late 2026.'
  },
  {
    title: 'iPad handwriting and PDF annotation',
    caption:
      'Apple Pencil writing, searchable handwritten notes, and markup for PDFs inside the vault.'
  },
  {
    title: 'Offline mobile vault with conflict-safe sync',
    caption:
      'Keep writing without internet, then merge mobile changes safely when the vault reconnects.'
  },
  {
    title: 'Mobile share sheet, widgets, and quick capture',
    caption:
      'Capture links, text, images, and voice from iOS or Android without opening the full app.'
  },
  {
    title: 'Locked spaces for sensitive notes',
    caption: 'Biometric or passcode-gated areas for private notes inside an encrypted vault.'
  },
  {
    title: 'Public and shared vaults',
    caption: 'Publish notes to the web or collaborate on a shared workspace.'
  },
  {
    title: 'Plugin API',
    caption: 'Extend Memrynote with your own tools, integrations, and views.'
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
    period: 'August 2026',
    items: [
      {
        title: 'Web clipper live on the Chrome Web Store',
        caption:
          'Install the memrynote clipper straight from the Chrome Web Store — one click from any page to your Inbox.'
      }
    ]
  },
  {
    period: 'July 2026',
    items: [
      {
        title: 'Public launch',
        caption:
          'Direct downloads for macOS, Windows, and Linux, with purchases open and the waitlist retired.'
      },
      { title: 'Web clipper for Firefox and Edge' },
      { title: 'Chrome Web Store publish pipeline' },
      { title: 'Persistent Connect Google Calendar prompt' },
      { title: 'Property-type icon doubles as a drag handle in properties' },
      { title: 'Faster macOS auto-updates via app.asar repack' }
    ]
  },
  {
    period: 'June 2026',
    items: [
      {
        title: 'Web clipper',
        caption: 'Capture pages, highlights, and snippets straight into your Inbox from Chrome.'
      },
      {
        title: 'Importers',
        caption:
          'Bring your vault over from Obsidian, Notion, Roam, Bear, Evernote, Apple Notes, Google Keep, Todoist, TickTick, Raindrop, and CSV.'
      },
      { title: 'Optional per-module toggles to turn features on or off' },
      { title: 'First-run interactive onboarding tour' },
      { title: 'Account and sync settings redesign' },
      { title: 'Agent provider auto-save with inline connection checks' },
      { title: 'Calendar drag-and-drop event reschedule and resize' },
      { title: 'Broad native application menu bar' },
      { title: 'Default white theme for new users' }
    ]
  },
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
      { title: 'Memrynote CLI' },
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
      { title: 'Optional inline AI editing in the editor' },
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
      { title: 'Sync E2EE rollout: Phases 1 through 15' }
    ]
  },
  {
    period: 'January 2026',
    items: [
      { title: 'Folder view with table layout, columns, filters, and formulas' },
      { title: 'Advanced search with operators and filters' },
      { title: 'Reminders for notes, journals, and highlights' },
      { title: 'Templates with folder defaults and version history' },
      { title: 'Optional AI filing suggestions with feedback tracking' },
      { title: 'Local embedding vector search via sqlite-vec' },
      { title: 'Property drag-and-drop, renaming, and unified API' },
      { title: 'Test infrastructure: Vitest and Playwright with seeded fixtures' },
      { title: 'Sync E2EE architecture and specification' }
    ]
  },
  {
    period: 'December 2025',
    items: [
      { title: 'Initial app scaffold and sidebar navigation' },
      {
        title: 'Task system v1',
        caption:
          'List, Kanban, subtasks, due dates, priorities, recurring rules, drag-and-drop, and bulk actions.'
      },
      { title: 'Split-view tab system with drag-and-drop between panes' },
      {
        title: 'Rich-text note editor',
        caption:
          'Slash commands, callouts, wiki-links, tags, properties, attachments, and version history.'
      },
      {
        title: 'Journal v1',
        caption: 'Day cards, calendar heatmap, focus mode, and optional AI suggestions.'
      },
      {
        title: 'Inbox capture: text, URLs, images, and voice',
        caption: 'Quick-capture window with a global shortcut.'
      },
      { title: 'Vault management and full-text search (Drizzle + SQLite + FTS5)' }
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
    <>
      <PageHead page="roadmap" />
      <PageHero
        tint={SITE_TINTS.roadmap}
        eyebrow="Building in public"
        title="Roadmap"
        sub="What is available, what is active, and what is planned next. This is direction, not a release promise."
        actions={
          <>
            {/* Labelled "Changelog" but pointing at GitHub releases, not /changelog. That
                looks wrong, but it is pre-existing behaviour and this is a re-skin —
                changing where a link goes belongs in its own commit. */}
            <FeatureChip
              label="Changelog"
              href={`${GITHUB_URL}/releases`}
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            />
            <FeatureChip
              label="Request a feature"
              href={`${GITHUB_URL}/issues`}
              trailingIcon={<ArrowRight className="h-4 w-4" />}
            />
          </>
        }
      />
      <main className="pb-24 pt-4">
        <Container size="md">
          <section className="border-b border-border py-12">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[140px_1fr] md:gap-10">
              <div className="md:pt-5">
                <StatusPill label="Active" tone="sage" count={ACTIVE_ITEMS.length} />
              </div>
              <RoadmapList items={ACTIVE_ITEMS} />
            </div>
          </section>

          <section className="border-b border-border py-12">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[140px_1fr] md:gap-10">
              <div className="md:pt-5">
                <StatusPill label="Planned" tone="terracotta" count={PLANNED_ITEMS.length} />
              </div>
              <RoadmapList items={PLANNED_ITEMS} />
            </div>
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
    </>
  )
}
