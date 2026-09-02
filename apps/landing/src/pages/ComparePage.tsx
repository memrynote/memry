import { Link } from 'react-router'
import { motion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { ALTERNATIVES, COMPARE_CARDS, type AlternativeConfig } from '@/lib/alternatives'
import { PAGE_META } from '@/lib/seo'

const REVEAL = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const }
}

// 2-3 sentence differentiation copy per competitor, keyed by pageKey. Facts here are drawn
// from each competitor's dedicated /X-alternative page — kept short and non-duplicative here.
const HUB_BLURBS: Record<AlternativeConfig['pageKey'], string> = {
  obsidianAlternative:
    'memrynote keeps the local Markdown vault, wiki-links, and backlinks Obsidian users already know, but ships tasks, a calendar, a daily journal, and an inbox as native features instead of community plugins. End-to-end encrypted sync is part of the product, not a separate paid add-on.',
  notionAlternative:
    'Notion stores your pages on its servers, where staff can technically read them. memrynote keeps every note as a plain Markdown file on your device and encrypts sync with XChaCha20-Poly1305, so the server only ever holds ciphertext.',
  noteplanAlternative:
    "NotePlan's daily-notes and task-backlink workflow is built around Apple platforms and leans on iCloud for sync. memrynote brings the same daily-notes flow to Windows and Linux too, with zero-knowledge encrypted sync that isn't tied to iCloud.",
  capacitiesAlternative:
    'Capacities organizes knowledge as typed objects in a cloud database. memrynote keeps notes as plain Markdown files on your disk, works fully offline, and ships a dedicated task system with Kanban, list, and calendar views that Capacities does not natively include.',
  evernoteAlternative:
    "Evernote's free tier caps you at 50 notes on one device and stores everything in its own ENML format. memrynote's local vault is free forever with no note limit, stores notes as plain .md files, and adds built-in tasks, a calendar, and a daily journal Evernote lacks.",
  logseqAlternative:
    'Both memrynote and Logseq store notes as local Markdown with wiki-links and backlinks. The difference is scope and editing model: memrynote is document-first rather than block-first, and ships tasks, a calendar, and an inbox natively instead of through plugins and iCloud or Dropbox sync.',
  anytypeAlternative:
    'memrynote and Anytype share a local-first, end-to-end encrypted foundation, but Anytype stores content in a proprietary object database only its own app can read. memrynote notes are plain Markdown files any editor can open, plus built-in tasks, a calendar, and a journal with no object types to configure.',
  appleNotesAlternative:
    'Apple Notes is polished but Apple-only, stores notes in a proprietary format, and offers only basic checklists. memrynote runs on Windows and Linux too, keeps notes as plain Markdown files you own, and adds real task management, a calendar, and a daily journal.',
  bearAlternative:
    "Bear is a beautiful writing app, but it's Apple-only and keeps notes in its own database. memrynote runs natively on Windows and Linux too, stores every note as a Markdown file you own, and adds task management, a calendar, and a daily journal Bear doesn't offer.",
  roamAlternative:
    'Roam Research requires a paid subscription from day one and stores your graph in its own cloud. memrynote is free for local use, stores notes as plain Markdown files, and starts encrypted sync at $5/mo — though Roam still leads on block references and datalog queries.',
  onenoteAlternative:
    'OneNote notebooks live in OneDrive, where Microsoft can technically read them. memrynote encrypts every note on your device before it reaches a server, stores notes as plain Markdown files, and replaces OneNote-plus-To-Do-plus-Outlook with one integrated workspace.',
  upnoteAlternative:
    "UpNote keeps notes in its own database until you export them, and syncs without end-to-end encryption. memrynote's notes are already plain .md files on your disk, sync is zero-knowledge encrypted, and tasks, a calendar, and a journal are built in.",
  joplinAlternative:
    "Joplin and memrynote share an open-source, end-to-end encrypted Markdown foundation. memrynote's edge is consolidation — a built-in calendar, daily journal, and inbox where Joplin relies on plugins — though Joplin still syncs to more third-party backends like Dropbox and WebDAV.",
  googleKeepAlternative:
    'Google Keep is built for color-coded sticky notes inside your Google account, not a second brain. memrynote combines Markdown notes with wiki-links, full task projects, a calendar, and a daily journal, all encrypted end-to-end and stored as files you control.',
  tanaAlternative:
    "Tana structures your workspace with supertags in a proprietary cloud graph that isn't end-to-end encrypted. memrynote stores each note as a portable Markdown file, encrypts sync so the server never reads your content, and ships tasks, a calendar, and a journal with no schema to design first.",
  heptabaseAlternative:
    "Heptabase's infinite whiteboard is built for spatial thinking, but your cards live in a proprietary cloud format. memrynote trades the canvas for a complete daily workspace — Markdown notes, tasks, a calendar, and a journal — stored as files you own and synced with end-to-end encryption."
}

export function ComparePage() {
  return (
    <>
      <PageHead page="compare" />

      <section className="pt-28 pb-12 md:pt-36 md:pb-16">
        <Container size="lg">
          <motion.div {...REVEAL} className="max-w-3xl">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              Compare
            </p>
            <h1 className="mt-4 font-serif text-4xl leading-[1.08] text-ink text-balance md:text-5xl">
              memrynote vs <span className="italic text-terracotta">the rest.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
              Pick the app you use today and see how it stacks up — a local-first, end-to-end
              encrypted workspace that puts notes, tasks, a calendar, and a daily journal in one
              place, as plain Markdown files you own.
            </p>
          </motion.div>
        </Container>
      </section>

      <section className="pb-24 zone-transition">
        <Container size="lg">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ALTERNATIVES.map((alt) => {
              const { path } = PAGE_META[alt.pageKey]
              const card = COMPARE_CARDS[alt.pageKey]
              return (
                <motion.div key={alt.pageKey} {...REVEAL}>
                  <Link
                    to={path}
                    className="group flex h-full flex-col items-center rounded-sm border border-ink/10 bg-paper/60 p-8 text-center transition-colors hover:border-terracotta/40 hover:bg-terracotta/[0.04]"
                  >
                    <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-ink/10 bg-white shadow-sm">
                      <img
                        src={`/compare-logos/${card.logo}`}
                        alt={`${alt.competitor} logo`}
                        width={36}
                        height={36}
                        loading="lazy"
                        className="h-9 w-9 object-contain"
                      />
                    </span>
                    <span className="mt-5 font-serif text-xl text-ink">
                      memrynote vs {alt.competitor}
                    </span>
                    <span className="mt-2 text-sm leading-relaxed text-muted">{card.tagline}</span>
                    <span className="mt-5 inline-flex items-center gap-1.5 font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta">
                      Compare
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                    </span>
                  </Link>
                </motion.div>
              )
            })}
          </div>
        </Container>
      </section>

      <section className="pb-24 zone-transition">
        <Container size="md">
          <motion.div {...REVEAL} className="max-w-2xl">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              How memrynote differs
            </p>
            <p className="mt-4 font-serif text-3xl leading-[1.15] text-ink text-balance md:text-4xl">
              A closer look at <span className="italic text-terracotta">each app.</span>
            </p>
          </motion.div>

          <div className="mt-10 divide-y divide-ink/10 border-t border-ink/10">
            {ALTERNATIVES.map((alt) => {
              const { path } = PAGE_META[alt.pageKey]
              const card = COMPARE_CARDS[alt.pageKey]
              return (
                <motion.article key={alt.pageKey} {...REVEAL} className="py-10 first:pt-0">
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-8">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-ink/10 bg-white shadow-sm">
                      <img
                        src={`/compare-logos/${card.logo}`}
                        alt=""
                        width={28}
                        height={28}
                        loading="lazy"
                        className="h-7 w-7 object-contain"
                      />
                    </span>
                    <div className="min-w-0">
                      <h2 className="font-serif text-2xl text-ink">
                        memrynote vs{' '}
                        <span className="italic text-terracotta">{alt.competitor}</span>
                      </h2>
                      <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
                        {HUB_BLURBS[alt.pageKey]}
                      </p>
                      <Link
                        to={path}
                        className="mt-4 inline-flex items-center gap-1.5 font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta"
                      >
                        Full {alt.competitor} comparison
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </div>
                </motion.article>
              )
            })}
          </div>
        </Container>
      </section>
    </>
  )
}
