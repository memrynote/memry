import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowUpRight, Bot, Globe, Terminal, type LucideIcon } from 'lucide-react'
import { HomeSection, MegaCard, SectionTitle } from '@/components/sections/home2/primitives'
import { AgentChatWidget } from '@/components/sections/home2/widgets/AgentChatWidget'

// Apps people arrive from — every logo is a real file in public/compare-logos.
const IMPORT_LOGOS: { logo: string; name: string }[] = [
  { logo: 'obsidian.svg', name: 'Obsidian' },
  { logo: 'notion.png', name: 'Notion' },
  { logo: 'evernote.svg', name: 'Evernote' },
  { logo: 'bear.png', name: 'Bear' },
  { logo: 'apple-notes.png', name: 'Apple Notes' },
  { logo: 'onenote.png', name: 'OneNote' },
  { logo: 'roam-research.png', name: 'Roam Research' },
  { logo: 'logseq.png', name: 'Logseq' },
  { logo: 'joplin.svg', name: 'Joplin' },
  { logo: 'google-keep.svg', name: 'Google Keep' },
  { logo: 'upnote.png', name: 'UpNote' },
  { logo: 'tana.png', name: 'Tana' }
]

function BlockTitle({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sage/10 text-sage"
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </span>
      <h3 className="font-serif text-xl text-ink">{children}</h3>
    </div>
  )
}

/** Tiny terminal vignette — real commands from the CLI page. */
function CliVignette() {
  return (
    <div
      aria-hidden
      className="mt-5 rounded-xl bg-ink/5 px-3.5 py-3 font-mono text-[12px] leading-relaxed"
    >
      <p className="text-ink/80">
        <span className="text-terracotta">$</span> memrynote tasks list --status todo
      </p>
      <p className="text-muted">3 tasks · Review PR · Ship docs</p>
    </div>
  )
}

const LINK_CARD_CLASS =
  'group flex flex-col rounded-2xl border border-ink/5 bg-card p-6 shadow-sm ' +
  'transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-card'

export function ConnectedShowcase() {
  return (
    <HomeSection id="connected">
      <MegaCard tint="sage" eyebrow="Connected">
        <SectionTitle
          title={
            <>
              Everything&rsquo;s connected — on <em>your</em> terms
            </>
          }
          sub="An agent in your notes, a CLI in your terminal, a clipper in your browser — all reading the same local vault, all opt-in."
          className="mb-10 md:mb-12"
        />

        <div className="grid gap-4 lg:grid-cols-5">
          <article className="rounded-2xl border border-ink/5 bg-card p-6 shadow-sm md:p-8 lg:col-span-3">
            <BlockTitle icon={Bot}>Agent chat with real context</BlockTitle>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted">
              Chat with an AI agent that reads your vault through a localhost MCP server. Claude
              CLI, Codex CLI, or your own tools can plug in — reads are open, writes wait for your
              approval.
            </p>
            <AgentChatWidget className="mt-6" />
            <p className="mt-2 text-xs text-muted">Live demo — try it</p>
          </article>

          <div className="grid gap-4 lg:col-span-2">
            <Link to="/cli" className={LINK_CARD_CLASS}>
              <div className="flex items-start justify-between gap-3">
                <BlockTitle icon={Terminal}>The MemryNote CLI</BlockTitle>
                <ArrowUpRight
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-terracotta"
                />
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                Notes, tasks, journal, sync — everything is scriptable from the command line.
                Local-first, JSON-native.
              </p>
              <CliVignette />
            </Link>

            <Link to="/features/web-clipper" className={LINK_CARD_CLASS}>
              <div className="flex items-start justify-between gap-3">
                <BlockTitle icon={Globe}>Web clipper</BlockTitle>
                <ArrowUpRight
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-terracotta"
                />
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted">
                Clip any link from your browser straight into MemryNote — capture now, sort later.
              </p>
            </Link>
          </div>

          <article className="rounded-2xl border border-ink/5 bg-card p-6 shadow-sm md:p-8 lg:col-span-5">
            <h3 className="font-serif text-xl text-ink">Bring your notes with you</h3>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              Obsidian vaults open directly — same files, same [[wiki-links]]. Built-in importers
              handle Apple Notes, Bear, Evernote, and Notion, and everything lands as plain Markdown
              you own.
            </p>
            <ul className="mt-6 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {IMPORT_LOGOS.map((app) => (
                <li
                  key={app.logo}
                  className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-paper px-2 py-3 text-center"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-ink/10 bg-white shadow-sm">
                    <img
                      src={`/compare-logos/${app.logo}`}
                      alt=""
                      width={24}
                      height={24}
                      loading="lazy"
                      className="h-6 w-6 object-contain"
                    />
                  </span>
                  <span className="text-[11px] font-medium leading-tight text-muted">
                    {app.name}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-center text-xs text-muted">
              …and anywhere else that exports Markdown.
            </p>
          </article>
        </div>

        <div className="mt-10 text-center">
          <Link
            to="/features/ai-agent"
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 bg-card px-5 py-2.5 text-sm font-medium text-ink shadow-sm transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-card"
          >
            Learn more about the AI agent
            <ArrowRight aria-hidden className="h-4 w-4 text-terracotta" />
          </Link>
        </div>
      </MegaCard>
    </HomeSection>
  )
}
