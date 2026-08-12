import { Link } from 'react-router'
import { motion } from 'motion/react'
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Calendar,
  CheckSquare,
  Code,
  FileCode,
  FolderOpen,
  Hash,
  Image as ImageIcon,
  Inbox,
  Layers,
  Link2,
  ListChecks,
  ListOrdered,
  PenLine,
  Quote,
  RotateCcw,
  Sparkles,
  Star,
  Table as TableIcon,
  Type,
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

export function NotesFeaturePage() {
  return (
    <>
      <PageHead page="notes" />
      <main>
        <NotesHero />
        <EverythingInOnePlace />
        <WritingSurface />
        <ConnectEveryIdea />
        <PropertiesSection />
        <StructureThinking />
        <WorksWithRest />
        <NotesUseCases />
        <MoreNoteFeatures />
        <NotesFaq />
        <NotesFinalCta />
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

function NotesHero() {
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
          <Eyebrow>Notes</Eyebrow>
          <h1 className="mt-4 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
            Your second brain,
            <br />
            in <span className="italic text-terracotta">Markdown.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            A file-first notes app built on plain{' '}
            <code className="font-mono-accent text-ink">.md</code> files in a folder you own.
            Wiki-links connect every idea, properties give each note shape, and version history
            holds the receipts.
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
          <HeroEditorMock />
        </motion.div>
      </Container>
    </section>
  )
}

function HeroEditorMock() {
  return (
    <FeatureHeroScreenshot
      screenshot="notes"
      alt="memrynote notes page showing an Istanbul travel note with properties, tasks, and the AI agent panel"
      width={1648}
      height={1020}
    />
  )
}

const PROPERTY_TONE: Record<'amber' | 'terracotta' | 'sage', string> = {
  amber: 'bg-amber-500/15 text-amber-700',
  terracotta: 'bg-terracotta/15 text-terracotta',
  sage: 'bg-sage/15 text-sage'
}

function PropertyRow({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: LucideIcon
  label: string
  value: string
  tone: 'amber' | 'terracotta' | 'sage'
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md',
          PROPERTY_TONE[tone]
        )}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      </span>
      <span className="w-20 font-mono-accent text-[11px] uppercase tracking-[0.14em] text-muted">
        {label}
      </span>
      <span className="text-ink/85">{value}</span>
    </div>
  )
}

const ANCHOR_CARDS = [
  {
    icon: Type,
    title: 'Rich markdown',
    body: 'Headings, lists, code, quotes, tables — written as plain .md you can open anywhere.'
  },
  {
    icon: ImageIcon,
    title: 'Files inline',
    body: 'Drop images, PDFs, audio, and video into any note. Stored beside the markdown.'
  },
  {
    icon: RotateCcw,
    title: 'Version history',
    body: 'Auto-snapshots on save, plus manual checkpoints. Side-by-side diff to undo anything.'
  },
  {
    icon: FileCode,
    title: 'Portable forever',
    body: 'Export any note to PDF or markdown. Or just open the .md file in any editor.'
  }
] as const

function EverythingInOnePlace() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>One canvas, every input</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Everything in one place.
            <br />
            Write where your research lives.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Notes hold the work. Markdown text, file attachments, structured properties, and version
            history — no plugins required.
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

function WritingSurface() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>The writing surface</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            A writer&apos;s editor.
            <br />
            <span className="italic text-terracotta">Stays out of the way.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Slash commands for everything you need, a bubble menu when you need formatting, and
            keyboard shortcuts for the rest.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.1fr_0.9fr_0.9fr]">
          <SlashCommandMock />
          <BubbleMenuMock />
          <TableCodeMock />
        </div>
      </Container>
    </section>
  )
}

function SurfaceCard({
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

const SLASH_COMMAND_ITEMS: { icon: LucideIcon; label: string; hint: string; active?: boolean }[] = [
  { icon: Type, label: 'Heading 1', hint: 'H1' },
  { icon: ListChecks, label: 'Task list', hint: '/task', active: true },
  { icon: TableIcon, label: 'Table', hint: '/table' },
  { icon: Code, label: 'Code block', hint: '```' },
  { icon: Quote, label: 'Quote', hint: '/quote' }
]

function SlashCommandMock() {
  const items = SLASH_COMMAND_ITEMS
  return (
    <SurfaceCard
      label="Slash commands"
      title="Type / for anything."
      body="Pull blocks, links, callouts, and code from a single menu."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-1.5 shadow-inner">
        <div className="px-3 pb-2 pt-1.5 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
          Insert
        </div>
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li
              key={item.label}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm',
                item.active
                  ? 'bg-terracotta/10 text-terracotta'
                  : 'text-ink/80 hover:bg-paper-alt/60'
              )}
            >
              <span className="flex items-center gap-2.5">
                <item.icon className="h-4 w-4" strokeWidth={1.8} />
                {item.label}
              </span>
              <span className="font-mono-accent text-[11px] tracking-wide text-muted">
                {item.hint}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </SurfaceCard>
  )
}

function BubbleMenuMock() {
  return (
    <SurfaceCard
      label="Bubble menu"
      title="Format what you select."
      body="Highlight any text to get a context-aware toolbar — link, bold, italic, headings."
    >
      <div className="relative rounded-xl border border-border/60 bg-paper p-5">
        <p className="text-[15px] leading-relaxed text-ink/85">
          memrynote connects every idea with{' '}
          <span className="relative inline-block">
            <span className="rounded bg-terracotta/15 px-1.5 py-0.5 text-ink">
              wiki-links and backlinks
            </span>
            <span className="absolute -top-12 left-1/2 -translate-x-1/2 rounded-full border border-border/70 bg-card px-2 py-1.5 shadow-card">
              <span className="flex items-center gap-1 text-[12px] font-medium text-ink">
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 font-mono-accent hover:bg-paper-alt"
                >
                  B
                </button>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 font-mono-accent italic hover:bg-paper-alt"
                >
                  I
                </button>
                <span className="h-3 w-px bg-border" />
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-terracotta hover:bg-paper-alt"
                >
                  <Link2 className="h-3.5 w-3.5" />
                </button>
                <button type="button" className="rounded px-1.5 py-0.5 hover:bg-paper-alt">
                  <Hash className="h-3.5 w-3.5" />
                </button>
              </span>
            </span>
          </span>{' '}
          so your thoughts never live alone.
        </p>
      </div>
    </SurfaceCard>
  )
}

function TableCodeMock() {
  return (
    <SurfaceCard
      label="Blocks"
      title="Tables, code, callouts."
      body="Everything you need in a long-form note — without leaving the editor."
    >
      <div className="space-y-3">
        <div className="overflow-hidden rounded-xl border border-border/60 bg-paper">
          <div className="grid grid-cols-3 border-b border-border/50 bg-paper-alt/70 text-[12px] font-medium text-muted">
            <span className="px-3 py-2">Idea</span>
            <span className="px-3 py-2">Status</span>
            <span className="px-3 py-2">Linked</span>
          </div>
          <div className="grid grid-cols-3 border-b border-border/40 text-[13px] text-ink/85">
            <span className="px-3 py-2">PKM</span>
            <span className="px-3 py-2 text-sage">Live</span>
            <span className="px-3 py-2 text-terracotta">[[zk-method]]</span>
          </div>
          <div className="grid grid-cols-3 text-[13px] text-ink/85">
            <span className="px-3 py-2">Outliner</span>
            <span className="px-3 py-2 text-muted">Draft</span>
            <span className="px-3 py-2 text-terracotta">[[Roam]]</span>
          </div>
        </div>
        <pre className="overflow-hidden rounded-xl border border-border/60 bg-dark px-4 py-3 font-mono-accent text-[12px] leading-relaxed text-ink-inverted/85">
          <code>
            <span className="text-terracotta-glow">function</span>{' '}
            <span className="text-paper">link</span>(note) {'{'}
            {'\n'} <span className="text-terracotta-glow">return</span>{' '}
            <span className="text-paper">`[[${'{note.title}'}]]`</span>
            {'\n'}
            {'}'}
          </code>
        </pre>
      </div>
    </SurfaceCard>
  )
}

function ConnectEveryIdea() {
  return (
    <section className="relative bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Linked thought</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Connect every idea.
            <br />
            <span className="italic text-terracotta">Grow a graph as you write.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Wiki-links suggest themselves while you type. Backlinks show every reference with
            context. Tags color-code the connective tissue.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          <WikiLinkMock />
          <div className="grid gap-5">
            <BacklinksPanelMock />
            <TagClusterMock />
          </div>
        </div>
      </Container>
    </section>
  )
}

const WIKI_LINK_SUGGESTIONS = [
  { title: 'zettelkasten-method', hint: 'Aliases: zk, slip-box' },
  { title: 'zone-of-proximal-development', hint: 'Tags: #learning' },
  { title: 'zero-to-one — Peter Thiel', hint: 'Folder: reading-notes' }
]

function WikiLinkMock() {
  const suggestions = WIKI_LINK_SUGGESTIONS
  return (
    <motion.article
      {...fadeUp}
      className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-7 shadow-card md:p-9"
    >
      <Eyebrow>Wiki-link suggestions</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">
        Type{' '}
        <span className="rounded-md bg-terracotta/15 px-2 py-1 font-mono-accent text-xl text-terracotta">
          [[
        </span>
        . memrynote finishes the thought.
      </h3>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
        Autocomplete matches titles, aliases, and tags. Hit enter — the connection sticks, no matter
        if you rename later.
      </p>

      <div className="mt-7 rounded-xl border border-border/60 bg-paper-alt/50 p-5">
        <p className="text-[15px] leading-relaxed text-ink/85">
          I keep coming back to{' '}
          <span className="rounded bg-terracotta/15 px-1.5 py-0.5 font-mono-accent text-[14px] text-terracotta">
            [[ze
          </span>
          <span className="inline-block h-5 w-px translate-y-0.5 bg-terracotta align-middle motion-safe:animate-pulse" />
        </p>
        <div className="mt-4 overflow-hidden rounded-xl border border-border/70 bg-card shadow-elevated">
          <p className="px-4 py-2 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
            3 matches
          </p>
          {suggestions.map((s, i) => (
            <button
              type="button"
              key={s.title}
              className={cn(
                'flex w-full items-center justify-between gap-3 px-4 py-2.5 text-start text-sm',
                i === 0 ? 'bg-terracotta/10 text-terracotta' : 'text-ink/80 hover:bg-paper-alt/60'
              )}
            >
              <span className="font-mono-accent">{s.title}</span>
              <span className="text-[11px] text-muted">{s.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </motion.article>
  )
}

function BacklinksPanelMock() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <Eyebrow>Backlinks</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">Every reference, in context.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        See exactly where a note is mentioned across your vault — with the surrounding sentence.
      </p>
      <ul className="mt-5 space-y-3 text-[13px]">
        <li className="rounded-lg border border-border/50 bg-paper-alt/40 px-3 py-2.5">
          <p className="font-medium text-ink">Journal · Apr 02</p>
          <p className="mt-1 text-muted">
            Revisited <span className="text-terracotta">[[zettelkasten-method]]</span> — still the
            cleanest mental model.
          </p>
        </li>
        <li className="rounded-lg border border-border/50 bg-paper-alt/40 px-3 py-2.5">
          <p className="font-medium text-ink">PKM principles</p>
          <p className="mt-1 text-muted">
            See also <span className="text-terracotta">[[zettelkasten-method]]</span>.
          </p>
        </li>
      </ul>
    </motion.article>
  )
}

const TAG_CLUSTER_TAGS = [
  { label: '#pkm', count: 38, tone: 'terracotta' },
  { label: '#writing', count: 24, tone: 'sage' },
  { label: '#reading', count: 19, tone: 'amber' },
  { label: '#research', count: 12, tone: 'terracotta' },
  { label: '#daily', count: 117, tone: 'sage' },
  { label: '#ideas', count: 64, tone: 'terracotta' }
] as const

const TAG_CLUSTER_TONE_CLASS: Record<(typeof TAG_CLUSTER_TAGS)[number]['tone'], string> = {
  terracotta: 'border-terracotta/30 bg-terracotta/8 text-terracotta',
  sage: 'border-sage/30 bg-sage/10 text-sage',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700'
}

function TagClusterMock() {
  const tags = TAG_CLUSTER_TAGS
  const toneClass = TAG_CLUSTER_TONE_CLASS

  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <Eyebrow>Tags & aliases</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">Color-coded connective tissue.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Tag with <code className="font-mono-accent text-terracotta">#topic</code>, give notes an
        alias, and find them however you remember them.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {tags.map((tag) => (
          <span
            key={tag.label}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-accent text-[12px]',
              toneClass[tag.tone]
            )}
          >
            {tag.label}
            <span className="rounded-full bg-card/60 px-1.5 text-[10px] text-ink/80">
              {tag.count}
            </span>
          </span>
        ))}
      </div>
    </motion.article>
  )
}

const PROPERTY_TYPES = [
  { icon: Type, label: 'Text' },
  { icon: ListOrdered, label: 'Number' },
  { icon: CheckSquare, label: 'Checkbox' },
  { icon: Calendar, label: 'Date' },
  { icon: Link2, label: 'URL' },
  { icon: Star, label: 'Rating' },
  { icon: Hash, label: 'Select' },
  { icon: Layers, label: 'Multi-select' }
] as const

function PropertiesSection() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.2fr]">
          <motion.div {...fadeUp}>
            <Eyebrow>Properties</Eyebrow>
            <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
              Every note has a shape.
              <br />
              <span className="italic text-terracotta">You choose it.</span>
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
              YAML frontmatter, rendered as a clean property panel. Eight property types cover
              status, dates, ratings, URLs, and more — sortable and filterable inside folder views.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {PROPERTY_TYPES.map((p) => (
                <span
                  key={p.label}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm text-ink/85 shadow-sm"
                >
                  <p.icon className="h-3.5 w-3.5 text-terracotta" strokeWidth={1.8} />
                  {p.label}
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
              <span className="text-2xl">🛠️</span>
              <h3 className="font-serif text-xl text-ink">Project · memrynote launch</h3>
            </div>
            <div className="mt-4 space-y-2 text-[14px]">
              <PropertyRow icon={Type} label="Status" value="On track" tone="sage" />
              <PropertyRow
                icon={ListOrdered}
                label="Effort"
                value="34 / 60 pts"
                tone="terracotta"
              />
              <PropertyRow icon={Calendar} label="Due" value="Q4 2026" tone="amber" />
              <PropertyRow
                icon={Link2}
                label="Spec"
                value="docs.memrynote.com/specs"
                tone="terracotta"
              />
              <PropertyRow icon={Star} label="Priority" value="★★★★★" tone="terracotta" />
              <PropertyRow icon={Hash} label="Tag" value="#launch" tone="sage" />
              <PropertyRow
                icon={Layers}
                label="Team"
                value="kaan · vendor · contractor"
                tone="terracotta"
              />
              <PropertyRow icon={CheckSquare} label="Reviewed" value="Yes" tone="sage" />
            </div>
            <p className="mt-5 rounded-lg bg-paper-alt/60 px-3 py-2 font-mono-accent text-[11px] text-muted">
              Stored in YAML frontmatter — readable by any markdown editor.
            </p>
          </motion.div>
        </div>
      </Container>
    </section>
  )
}

const STRUCTURE_CARDS = [
  {
    icon: FolderOpen,
    title: 'Folder views',
    body: 'Turn any folder into a database-style table. Sort, filter, and group by property.'
  },
  {
    icon: TableIcon,
    title: 'Tables in-line',
    body: 'First-class table editing with sortable headers and cell-level formatting.'
  },
  {
    icon: Sparkles,
    title: 'Formula columns',
    body: 'Compute values from other properties — sums, counts, dates, rollups.'
  },
  {
    icon: Code,
    title: 'Code blocks',
    body: 'Syntax-highlighted fences for the language you actually write in.'
  },
  {
    icon: Quote,
    title: 'Quotes & callouts',
    body: 'Pull a passage, mark a footnote, or stamp a callout without leaving the keyboard.'
  },
  {
    icon: ListChecks,
    title: 'Task lists',
    body: 'Inline checkboxes that surface as real tasks in the Tasks view — same source of truth.'
  }
] as const

function StructureThinking() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Structure</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Structure your thinking.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            From a loose paragraph to a fully-indexed reading list — the same notes scale with you.
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
    body: 'Capture anything anywhere — file it into a note with a click. Source link preserved.'
  },
  {
    icon: PenLine,
    title: 'In Journal',
    body: 'Daily entries link back to the notes you reference. Today wires into yesterday.'
  },
  {
    icon: CheckSquare,
    title: 'With Tasks',
    body: 'Inline checkboxes become real tasks. Click through to the source note any time.'
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
            Notes don&apos;t live in a silo. They connect to your inbox, your journal, and your
            tasks — same vault, same shortcuts.
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
    icon: PenLine,
    title: 'Writers',
    body: 'Long drafts, character sheets, research threads — all linked, all in plain markdown.'
  },
  {
    icon: Bookmark,
    title: 'Researchers',
    body: 'Quote-grab from the web, structure findings with properties, then publish locally.'
  },
  {
    icon: FolderOpen,
    title: 'Builders',
    body: 'Spec docs, ADRs, runbooks. Folder views give you a database without leaving markdown.'
  },
  {
    icon: Sparkles,
    title: 'Lifelong learners',
    body: 'A zettelkasten that grows with you. Backlinks reveal the patterns you keep returning to.'
  }
] as const

function NotesUseCases() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Use cases</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for thinkers.
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
  { icon: Star, title: 'Emoji icons', body: 'Pin a visual identifier to every note.' },
  { icon: FileCode, title: 'PDF & Markdown export', body: 'One click to share outside memrynote.' },
  {
    icon: Layers,
    title: 'Aliases',
    body: 'Multiple names for the same note. Find it however you remember it.'
  },
  { icon: ImageIcon, title: 'Attachments inline', body: 'Images, audio, video, PDFs — embedded.' },
  {
    icon: RotateCcw,
    title: 'Snapshots on save',
    body: 'Auto and manual. Side-by-side diff to roll back anything.'
  },
  {
    icon: Hash,
    title: 'Tag definitions',
    body: 'Pin a description to a tag so future-you remembers what it meant.'
  }
] as const

function MoreNoteFeatures() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>And more</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Wait — there&apos;s more.
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
                <m.icon className="h-4.5 w-4.5" strokeWidth={1.8} />
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

const NOTES_FAQ = [
  {
    question: 'Are my notes really just plain Markdown files?',
    answer:
      'Yes. Every note is a .md file in a vault folder you choose. YAML frontmatter holds the properties. You can open the same file in Obsidian, iA Writer, VS Code, or any text editor.'
  },
  {
    question: 'Do wiki-links break if I rename a note?',
    answer:
      'No. memrynote tracks links by identity, not by filename. Rename a note and every [[wiki-link]] in your vault updates automatically — including the ones inside journal entries and task descriptions.'
  },
  {
    question: 'How does version history work?',
    answer:
      'memrynote snapshots every save automatically. You can also pin a manual checkpoint before a big edit. Side-by-side diffs let you roll back any change — and every snapshot stays local.'
  },
  {
    question: 'Can I import from Obsidian or Notion?',
    answer:
      'Obsidian vaults open directly — same file format, same [[wiki-link]] syntax. Notion exports import as plain markdown with frontmatter preserved.'
  },
  {
    question: 'What about real-time collaboration?',
    answer:
      'Notes sync end-to-end encrypted across your own devices today via the CRDT layer. Multi-user real-time collaboration is on the roadmap.'
  }
]

function NotesFaq() {
  return (
    <section className="border-t border-border/40 bg-paper-alt/35 py-24">
      <Container size="sm">
        <motion.div {...fadeUp} className="mb-12 text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-4xl">
            Notes, answered.
          </h2>
        </motion.div>

        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <Accordion type="single" collapsible className="w-full">
            {NOTES_FAQ.map((item, i) => (
              <AccordionItem
                key={item.question}
                value={`notes-faq-${i}`}
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

function NotesFinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_55%)]"
      />
      <Container size="md">
        <motion.div {...fadeUp} className="text-center">
          <h2 className="mx-auto max-w-2xl font-serif text-4xl font-normal leading-tight text-ink text-balance md:text-5xl">
            The workspace that thinks with you.{' '}
            <span className="italic text-terracotta">Ready when you are.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Local-first. End-to-end encrypted. Plain markdown files in a folder you own — forever.
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
