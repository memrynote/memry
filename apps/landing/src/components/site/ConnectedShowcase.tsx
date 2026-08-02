import { motion, useReducedMotion } from 'framer-motion'
import { Link } from 'react-router'
import { ArrowUpRight } from 'lucide-react'
import { ClipperStack } from '@/components/site/ClipperStack'
import { HomeSection, SectionTitle } from '@/components/site/primitives'
import { AgentChatWidget } from '@/components/site/widgets/AgentChatWidget'
import { CliWidget } from '@/components/site/widgets/CliWidget'
import { Mascot } from '@/components/ui/mascot'
import { cn } from '@/lib/utils'

const EASE = [0.16, 1, 0.3, 1] as const

const DOCS_IMPORT_URL = 'https://docs.memrynote.com/user-guide/import'

/*
 * Apps people arrive from — every logo is a real file in public/compare-logos.
 * `docs` deep-links the import guide. Obsidian has no anchor because it isn't an import
 * (the vault opens directly); Logseq, Joplin, UpNote and Tana have no importer of their
 * own — they export Markdown, so they point at the Markdown importer.
 */
const IMPORT_LOGOS: { logo: string; name: string; docs: string }[] = [
  { logo: 'obsidian.svg', name: 'Obsidian', docs: DOCS_IMPORT_URL },
  { logo: 'notion.png', name: 'Notion', docs: `${DOCS_IMPORT_URL}#importing-from-notion` },
  { logo: 'evernote.svg', name: 'Evernote', docs: `${DOCS_IMPORT_URL}#importing-from-evernote` },
  { logo: 'bear.png', name: 'Bear', docs: `${DOCS_IMPORT_URL}#importing-from-bear` },
  {
    logo: 'apple-notes.png',
    name: 'Apple Notes',
    docs: `${DOCS_IMPORT_URL}#importing-from-apple-notes`
  },
  { logo: 'onenote.png', name: 'OneNote', docs: `${DOCS_IMPORT_URL}#importing-from-onenote` },
  {
    logo: 'roam-research.png',
    name: 'Roam Research',
    docs: `${DOCS_IMPORT_URL}#importing-from-roam-research`
  },
  { logo: 'logseq.png', name: 'Logseq', docs: `${DOCS_IMPORT_URL}#importing-from-markdown` },
  { logo: 'joplin.svg', name: 'Joplin', docs: `${DOCS_IMPORT_URL}#importing-from-markdown` },
  {
    logo: 'google-keep.svg',
    name: 'Google Keep',
    docs: `${DOCS_IMPORT_URL}#importing-from-google-keep`
  },
  { logo: 'upnote.png', name: 'UpNote', docs: `${DOCS_IMPORT_URL}#importing-from-markdown` },
  { logo: 'tana.png', name: 'Tana', docs: `${DOCS_IMPORT_URL}#importing-from-markdown` }
]

/*
 * Every surface reading the same local vault — a bento of feature tiles. Each tile is
 * a title + a visual (the image carries the meaning; no prose). Every tile owns a soft
 * pastel so the eye rests on one feature at a time. Two tiles are real, interactive UI
 * (the MCP agent + the CLI); the rest are theme-aware app screenshots.
 *
 * Visual kinds:
 *   'agent'      — live AgentChatWidget replica          (bottom row, beside the CLI)
 *   'cli'        — live, auto-playing CliWidget           (bottom row, beside the agent)
 *   'screenshot' — framed theme-pair /screenshots/<id>_{white,black}.png
 *   'folder'     — the folder table view, a single framed screenshot (light only)
 *   'clipper'    — the web clipper popup stacked over the note it captured
 */
type FeatureVisualKind = 'agent' | 'cli' | 'screenshot' | 'folder' | 'clipper'

// Keys map to --color-tint-* tokens in index.css (light + dark pairs).
type FeatureTint = 'peach' | 'sky' | 'sage' | 'rose' | 'lilac' | 'sand' | 'mint'

const TINT_CLASS: Record<FeatureTint, string> = {
  peach: 'bg-tint-peach',
  sky: 'bg-tint-sky',
  sage: 'bg-tint-sage',
  rose: 'bg-tint-rose',
  lilac: 'bg-tint-lilac',
  sand: 'bg-tint-sand',
  mint: 'bg-tint-mint'
}

interface FeatureTile {
  id: string
  /** Hand-drawn mascot under /mascots; the dark twin is derived by <Mascot>. */
  mascot: string
  title: string
  tint: FeatureTint
  visual: FeatureVisualKind
  alt?: string // richer alt text for screenshot visuals; falls back to the title
  scale?: number // zoom factor for screenshot visuals when the source is dense (e.g. 1.3)
  href?: string
  wide?: boolean // spans both columns
}

const TILES: FeatureTile[] = [
  {
    id: 'folder-view',
    mascot: '/mascots/folder-tags.png',
    title: 'Folder views',
    tint: 'peach',
    visual: 'folder'
  },
  {
    id: 'graph',
    mascot: '/mascots/links-graph.png',
    title: 'Graph view',
    tint: 'sky',
    visual: 'screenshot',
    alt: 'The knowledge graph — every note a node, links drawn between them'
  },
  {
    id: 'home',
    mascot: '/mascots/home.png',
    title: 'Home dashboard',
    tint: 'rose',
    visual: 'screenshot',
    alt: 'The home dashboard — tasks, calendar, inbox and journal in one view',
    scale: 1.3 // the dashboard is dense; zoom in ~30% so the widgets read
  },
  {
    id: 'web-clipper',
    mascot: '/mascots/web-clipper.png',
    title: 'Web clipper',
    tint: 'lilac',
    visual: 'clipper',
    href: '/features/web-clipper'
  },
  {
    id: 'cli',
    mascot: '/mascots/cli.png',
    title: 'The MemryNote CLI',
    tint: 'sand',
    visual: 'cli',
    href: '/cli'
  },
  {
    id: 'mcp',
    mascot: '/mascots/ai-agent.png',
    title: 'MCP, both ways',
    tint: 'mint',
    visual: 'agent',
    href: '/features/ai-agent'
  }
]

/** Framed screenshot — /screenshots/<base>_white.png. */
function ScreenshotFrame({ base, alt, scale }: { base: string; alt: string; scale?: number }) {
  const src = `/screenshots/${base}_white.png`
  return (
    <div className="overflow-hidden rounded-2xl border border-ink/10 shadow-card">
      <img
        src={src}
        alt={alt}
        width={1600}
        height={1200}
        loading="lazy"
        decoding="async"
        className="block aspect-[4/3] w-full object-cover object-top"
        style={
          scale
            ? {
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                objectPosition: 'left top'
              }
            : undefined
        }
      />
    </div>
  )
}

/**
 * A folder as a table view — a single framed screenshot (light only, no theme pair).
 * Shown at its native ratio (full width, auto height) so the wide table never gets
 * side-cropped.
 */
function FolderShot() {
  return (
    <div className="overflow-hidden rounded-2xl border border-ink/10 shadow-card">
      <img
        src="/screenshots/folder-view-white.png"
        alt="A folder as a table — title, tags, director, year and genre columns, rows selected"
        width={876}
        height={612}
        loading="lazy"
        decoding="async"
        className="block h-auto w-full"
      />
    </div>
  )
}

function FeatureVisual({ tile }: { tile: FeatureTile }) {
  switch (tile.visual) {
    case 'cli':
      return <CliWidget />
    case 'agent':
      return <AgentChatWidget />
    case 'screenshot':
      return <ScreenshotFrame base={tile.id} alt={tile.alt ?? tile.title} scale={tile.scale} />
    case 'folder':
      return <FolderShot />
    case 'clipper':
      return <ClipperStack />
  }
}

function FeatureTileCard({ tile, index }: { tile: FeatureTile; index: number }) {
  const prefersReducedMotion = useReducedMotion()

  const heading = <h3 className="font-serif text-lg text-ink md:text-xl">{tile.title}</h3>

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.6, ease: EASE, delay: (index % 2) * 0.06 }}
      className={cn(
        'flex flex-col rounded-3xl border border-ink/5 p-6 md:p-7',
        TINT_CLASS[tile.tint],
        tile.wide && 'sm:col-span-2'
      )}
    >
      <div className="flex items-center gap-2.5">
        <Mascot src={tile.mascot} className="h-8 w-8 shrink-0" />
        {tile.href ? (
          <Link
            to={tile.href}
            className="group inline-flex items-center gap-1.5 transition-colors hover:text-terracotta"
          >
            {heading}
            <ArrowUpRight
              aria-hidden
              className="h-4 w-4 text-terracotta transition-transform duration-300 group-hover:-translate-y-0.5"
            />
          </Link>
        ) : (
          heading
        )}
      </div>
      <div className="mt-5 flex-1">
        <FeatureVisual tile={tile} />
      </div>
    </motion.div>
  )
}

export function ConnectedShowcase() {
  return (
    <HomeSection id="connected">
      <div className="mx-auto w-full max-w-6xl">
        <SectionTitle
          eyebrow="Connected"
          title={
            <>
              Everything&rsquo;s connected — on <em>your</em> terms
            </>
          }
          sub="One local vault, many front doors — an MCP agent, folder views, a graph view, your home dashboard, a web clipper and a terminal CLI, all reading and writing the same Markdown you own."
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-5">
          {TILES.map((tile, i) => (
            <FeatureTileCard key={tile.id} tile={tile} index={i} />
          ))}

          {/* Bring your notes with you — neutral closing tile */}
          <article className="rounded-3xl border border-ink/5 bg-card p-6 shadow-sm sm:col-span-2 md:p-8">
            <a
              href={DOCS_IMPORT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-1.5 transition-colors hover:text-terracotta"
            >
              <h3 className="font-serif text-lg text-ink md:text-xl">Bring your notes with you</h3>
              <ArrowUpRight
                aria-hidden
                className="h-4 w-4 text-terracotta transition-transform duration-300 group-hover:-translate-y-0.5"
              />
            </a>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
              Obsidian vaults open directly — same files, same [[wiki-links]]. Importers handle
              Apple Notes, Bear, Evernote, and Notion; everything lands as Markdown you own.
            </p>
            <ul className="mt-6 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
              {IMPORT_LOGOS.map((app) => (
                <li key={app.logo}>
                  <a
                    href={app.docs}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${app.name} — read the import guide`}
                    className="group flex h-full flex-col items-center gap-2 rounded-xl border border-border/60 bg-paper px-2 py-3 text-center transition duration-200 hover:-translate-y-0.5 hover:border-terracotta/40 hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/50"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-ink/10 bg-white shadow-sm transition-shadow duration-200 group-hover:shadow-card">
                      <img
                        src={`/compare-logos/${app.logo}`}
                        alt=""
                        width={24}
                        height={24}
                        loading="lazy"
                        className="h-6 w-6 object-contain"
                      />
                    </span>
                    <span className="text-[11px] font-medium leading-tight text-muted transition-colors duration-200 group-hover:text-terracotta">
                      {app.name}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </HomeSection>
  )
}
