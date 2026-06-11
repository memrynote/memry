import {
  ArrowRight,
  Brain,
  CalendarDays,
  FileText,
  GitBranch,
  Lock,
  Search,
  type LucideIcon
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { GITHUB_URL } from '@/lib/constants'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

interface ChangelogEntry {
  period: string
  title: string
  summary: string
  icon: LucideIcon
  highlights: string[]
}

const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    period: 'May 2026',
    title: 'Agent Chat, memrynote CLI, and voice workflows',
    summary: 'Agent work moved into the real vault.',
    icon: Brain,
    highlights: [
      'Agent Chat right sidebar',
      'Provider and model selection',
      'Codex CLI backend',
      'Per-turn permissions',
      'Vault-only, computer, and web access modes',
      'Approval-gated write tools',
      'Inline mentions across notes, tasks, journals, inbox, and calendar',
      'Agent inbox snooze tool',
      'Local Vault MCP server',
      'memrynote CLI setup',
      'Voice memos with transcription',
      'Audio previews and related items'
    ]
  },
  {
    period: 'April 2026',
    title: 'Calendar depth and full multilingual UI',
    summary: 'Calendar and language support became first-class.',
    icon: CalendarDays,
    highlights: [
      'English, Turkish, and Arabic UI',
      'Right-to-left Arabic layout',
      'Localized native menu',
      'Infinite horizontal week view',
      'Calendar day and week quick-create',
      'Calendar task popover',
      'Inbox-snooze calendar popover',
      'Google Calendar sync triggers',
      'OAuth diagnostics',
      'Imported calendar controls',
      'Inline subtasks in notes',
      'Inbox triage, snooze, and filing flows'
    ]
  },
  {
    period: 'March 2026',
    title: 'Collections, graph, global search, and richer notes',
    summary: 'The vault became searchable, linked, and structured.',
    icon: Search,
    highlights: [
      'Collections over vault notes',
      'Interactive knowledge graph',
      'Cmd+K global search',
      'FTS5 search with fuzzy fallback',
      'Redesigned note page',
      'Editor blocks and full-width notes',
      'Backlinks and wiki-link previews',
      'Select, status, and multiselect properties',
      'Hash-tag autocomplete',
      'Inbox triage mode',
      'Duplicate capture detection',
      'AI note suggestions'
    ]
  },
  {
    period: 'February 2026',
    title: 'End-to-end encrypted sync foundation',
    summary: 'Private multi-device sync landed.',
    icon: Lock,
    highlights: [
      'Cloudflare Workers sync server',
      'D1 metadata and R2 encrypted payloads',
      'XChaCha20-Poly1305 encryption',
      'Ed25519 device signing',
      'Argon2id key derivation',
      'Recovery phrases',
      'CRDT sync for notes and journals',
      'Field-level vector clocks for tasks and projects',
      'Device linking and device list',
      'Device revocation',
      'Key rotation wizard',
      'Local-only notes'
    ]
  },
  {
    period: 'January 2026',
    title: 'Folder views, advanced search, reminders, and local intelligence',
    summary: 'The early vault gained structure.',
    icon: FileText,
    highlights: [
      'Folder table views',
      'Column management',
      'Named views',
      'Advanced filters',
      'Formula columns',
      'Row grouping',
      'Advanced search operators',
      'Reminders for notes, journals, and highlights',
      'Templates with folder defaults',
      'Version history',
      'Unified properties API',
      'Local embedding search with sqlite-vec'
    ]
  },
  {
    period: 'December 2025',
    title: 'Desktop shell, notes, tasks, journal, and inbox',
    summary: 'The first local workspace came together.',
    icon: GitBranch,
    highlights: [
      'Desktop sidebar and navigation',
      'Vault management',
      'Drizzle and SQLite data layer',
      'Full-text search',
      'Split-view tabs',
      'Rich-text note editor',
      'Slash commands and callouts',
      'Wiki-links, tags, and backlinks',
      'Task lists and detail panel',
      'Kanban board',
      'Recurring tasks and subtasks',
      'Daily journal',
      'Inbox capture for text, URLs, images, and voice',
      'Quick capture global shortcut'
    ]
  }
]

export function ChangelogPage() {
  return (
    <>
      <PageHead page="changelog" />
      <main className="pt-32 pb-24 md:pt-40">
        <Container size="md">
          <motion.section
            initial={BLUR_REVEAL_INITIAL}
            animate={BLUR_REVEAL_ANIMATE}
            transition={BLUR_REVEAL_TRANSITION}
            className="border-b border-border pb-12 text-center"
          >
            <p className="font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta">
              Release notes
            </p>
            <h1 className="mt-4 font-serif text-5xl leading-[1.05] text-ink md:text-6xl">
              Changelog
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-muted">
              Major memrynote milestones from the first desktop scaffold on December 1, 2025 to the
              current launch push. Small fixes, copy changes, and operational release notes stay in
              GitHub.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3 text-sm">
              <a
                href={`${GITHUB_URL}/releases`}
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 font-medium text-ink transition-colors hover:border-terracotta/30 hover:text-terracotta"
              >
                GitHub releases
                <ArrowRight className="h-4 w-4" aria-hidden />
              </a>
              <Link
                to="/roadmap"
                className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 font-medium text-ink transition-colors hover:border-terracotta/30 hover:text-terracotta"
              >
                Roadmap
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </div>
          </motion.section>

          <section className="divide-y divide-border">
            {CHANGELOG_ENTRIES.map((entry) => {
              const Icon = entry.icon

              return (
                <article key={`${entry.period}-${entry.title}`} className="py-10">
                  <div className="grid gap-5 md:grid-cols-[150px_1fr] md:gap-10">
                    <div>
                      <p className="font-mono-accent text-xs uppercase tracking-[0.18em] text-muted">
                        {entry.period}
                      </p>
                    </div>
                    <div>
                      <div className="flex gap-4">
                        <div className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-paper-alt text-terracotta">
                          <Icon className="h-5 w-5" aria-hidden />
                        </div>
                        <div>
                          <h2 className="font-serif text-2xl leading-tight text-ink md:text-3xl">
                            {entry.title}
                          </h2>
                          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
                            {entry.summary}
                          </p>
                        </div>
                      </div>
                      <ul className="mt-6 grid gap-3 text-base leading-relaxed text-muted">
                        {entry.highlights.map((highlight) => (
                          <li key={`${entry.period}-${highlight}`} className="flex gap-3">
                            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-terracotta/70" />
                            <span>{highlight}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </article>
              )
            })}
          </section>
        </Container>
      </main>
    </>
  )
}
