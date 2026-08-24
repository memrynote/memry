import { motion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { PageHero } from '@/components/site/PageHero'
import { FeatureChip } from '@/components/site/primitives'
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
    title: 'Mobile apps — iPhone, iPad, and Android',
    caption:
      'Quick capture on phones plus an iPad-optimized writing and reading surface, backed by the same encrypted vault and offline-first sync as desktop.'
  },
  {
    title: 'Calendars beyond Google — ICS, CalDAV, Outlook, and Apple',
    caption:
      'Subscribe to any ICS feed (Proton, Notion, holiday calendars), connect CalDAV servers like Fastmail, Nextcloud, and iCloud, and sync Outlook / Microsoft 365.'
  }
]

const PLANNED_ITEMS: RoadmapItem[] = [
  {
    title: 'iPad handwriting and PDF annotation',
    caption:
      'Apple Pencil writing, searchable handwritten notes, and markup for PDFs inside the vault.'
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
        title: 'Note mind map',
        caption:
          'See a note as a live map of its headings, lists, tasks, and wiki links. Fold what runs past the caps, export it as an image, or save it as a canvas you own.'
      },
      {
        title: 'Real table editing',
        caption:
          'Handles on the border lines, row, column, and cell menus, cell colours that survive a save, and images inside cells.'
      },
      {
        title: 'Tabs come back the way you left them',
        caption:
          'Reuse the current tab on a plain click, restore scroll position and view state after a restart, and open any sidebar row in a new tab or beside this one.'
      },
      {
        title: 'Home boards sync across devices',
        caption:
          'Plus a manager for renaming, reordering, and deleting boards, a Project widget, a Recently opened widget, and the full due-date filter set in Tasks.'
      },
      {
        title: 'A sidebar you can order yourself',
        caption:
          'Drag the five sections into your own order and give each one a sort mode, synced per vault.'
      },
      {
        title: 'Custom icons for folders and notes',
        caption:
          'Use your own image, or pull one from a link. The bytes live in the vault and travel with it.'
      },
      { title: 'Tag categories, a tag hub, and single-tag pages' },
      {
        title: 'Project hub redesign and relation properties',
        caption:
          'Link notes, files, tasks, and events from a property, and assign a note to a project.'
      },
      {
        title: 'Canvases are plain .excalidraw files in your vault',
        caption:
          'With their own folder tree, and shapes that can link to any item in the vault by name.'
      },
      {
        title: 'Links that point inside a note',
        caption:
          'Pick a heading while you are still writing the link, give any link its own name, and address a place inside a note with a memry:// link.'
      },
      {
        title: 'PDF viewer rework',
        caption:
          'Scroll continuously through an embedded PDF, one toolbar with an editable page number, and documents that open fitted to their pane.'
      },
      { title: 'Tasks: per-task activity log, natural-language dates, and repeats in quick-add' },
      { title: 'Per-weekday journal templates, synced per day' },
      { title: 'Importers for NotePlan 3 and Microsoft OneNote' },
      { title: 'Multiple Google accounts in Calendar, with per-account calendar selection' },
      {
        title: 'Agent Chat composer rebuild',
        caption:
          'Voice dictation, a turn of tool activity collapsed into one row, and agents that can draw on a canvas over MCP.'
      },
      {
        title: 'Web clipper live on the Chrome Web Store',
        caption:
          'One click from any page to your Inbox, automated Firefox add-on publishing, and real PDF capture when the tab is a PDF.'
      },
      { title: 'Live force simulation with node dragging in graph view' },
      {
        title: 'Stability and fixes',
        caption:
          'A long sync and CRDT reliability sweep, tabs that survive a restart, quitting that saves your latest edits, attachments that resolve on a second device, folder renames without a phantom row, a search index that repairs itself, and Windows updates that install over a running binary.'
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
      {
        title: 'Spatial canvas',
        caption:
          'Drag notes, tasks, and events onto an infinite board, edit the cards in place, and sync the whole scene end-to-end encrypted.'
      },
      { title: 'Web clipper for Firefox and Edge' },
      { title: 'Chrome Web Store publish pipeline' },
      {
        title: 'Renamed to memrynote',
        caption:
          'Runtime identity, logs, stored secrets, and app data moved over, with a migration for existing installs.'
      },
      {
        title: 'Your vault files stay yours',
        caption:
          'No write without a semantic change, app keys out of your frontmatter, and filenames that avoid Obsidian-forbidden characters.'
      },
      { title: 'Resizable, alignable inline PDF embeds' },
      { title: 'Drag a task onto the calendar to schedule it' },
      { title: 'Tag tasks from the UI' },
      { title: 'Per-note and per-journal width, over a single global default' },
      { title: 'Darker two-tone dark theme' },
      {
        title: 'Landing site rebuild',
        caption: 'New homepage, pricing grid, dedicated /login, a /compare hub, and a clipper page.'
      },
      {
        title: 'Motion pass across calendar, home, editor, and landing',
        caption: 'Floating chrome, spring view transitions, and press feedback.'
      },
      {
        title: 'Vault recovery and deletion',
        caption:
          'Recover an orphaned vault with your recovery phrase, or delete a vault from your account while keeping the files on disk.'
      },
      { title: 'Secrets moved from keytar to Electron safeStorage' },
      { title: 'Daily inbox review reminder' },
      { title: 'Persistent Connect Google Calendar prompt' },
      { title: 'Property-type icon doubles as a drag handle in properties' },
      {
        title: 'Update flow rework',
        caption:
          'Short-interval polling, silent opt-in downloads, an in-app prompt, and a dedicated install screen on restart.'
      },
      {
        title: 'Stability and fixes',
        caption:
          'Attachments survive cross-device sync, notes stop arriving as Untitled, undo works from Ctrl+Z on Windows and Linux, opening a vault no longer waits on embeddings, and Google Calendar data is isolated from AI surfaces.'
      }
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
      {
        title: 'Folder views redesigned',
        caption:
          'List, Board, and Gallery layouts beside the table, with sorting, bulk actions, and multi-select.'
      },
      {
        title: 'A Home dashboard you can arrange',
        caption:
          'Drag and resize the widgets, including a tasks widget driven by your own saved filters.'
      },
      {
        title: 'Multiple vaults per account',
        caption:
          'A vault switcher, an account vault directory, and device linking that adopts the right vault instead of guessing.'
      },
      {
        title: 'Web account area on memrynote.com',
        caption: 'Passwordless sign-in with a billing and sync dashboard.'
      },
      { title: 'Task reminders with an upcoming and past panel in Inbox' },
      { title: 'One-way Google Calendar sync, for reading it without writing back' },
      { title: 'Inbox conversion: turn a captured item into an event, reminder, or task' },
      { title: 'Inline date and reminder mentions with /date' },
      { title: 'Custom tag colours and a per-tag icon picker' },
      { title: 'Flat vault root for Obsidian compatibility' },
      { title: 'Optional per-module toggles to turn features on or off' },
      { title: 'First-run interactive onboarding tour' },
      { title: 'Account and sync settings redesign' },
      { title: 'Agent provider auto-save with inline connection checks' },
      { title: 'Calendar drag-and-drop event reschedule and resize' },
      { title: 'Broad native application menu bar' },
      { title: 'Default white theme for new users' },
      {
        title: 'Stability and fixes',
        caption:
          'The auto-update restart loop is broken for good, Windows builds stopped failing on a locked env file, submenus escape their parent menu, and pending CRDT writes flush on shutdown instead of being dropped.'
      }
    ]
  },
  {
    period: 'May 2026',
    items: [
      {
        title: 'Agent Chat',
        caption:
          'A vault-aware assistant inside the app, backed by a local MCP server that exposes notes, tasks, journals, inbox, and calendar as read tools with approval-gated writes.'
      },
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
      { title: 'Every AI feature is optional, and off until you turn it on' },
      { title: 'Memrynote CLI' },
      {
        title: 'Paid sync tiers',
        caption:
          'A three-tier pricing page, account-linked checkout, per-vault storage accounting, and sync gated on a real entitlement.'
      },
      {
        title: 'Product telemetry you can switch off',
        caption: 'Anonymous usage and sync-reliability metrics, with a toggle in General settings.'
      },
      { title: 'Landing demo refresh, founder story, feature pages, and this roadmap' },
      { title: 'Terms, Privacy, and Refund pages' },
      { title: 'Date-based release versions with humanized release notes' },
      {
        title: 'Stability and fixes',
        caption:
          'Certificate pins scoped by hostname, a hardened Paddle checkout, dev profiles isolated per worktree, and agent runs that stop cleanly instead of duplicating their final result.'
      }
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
