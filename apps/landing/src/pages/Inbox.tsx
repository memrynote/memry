import { Link } from 'react-router'
import { motion } from 'motion/react'
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Brain,
  Calendar,
  CheckSquare,
  Clock,
  FileCode,
  FileText,
  FileVideo,
  FolderOpen,
  GraduationCap,
  Hash,
  Image as ImageIcon,
  Keyboard,
  Layers,
  Link2,
  Mic,
  MoonStar,
  PenLine,
  Scissors,
  Sparkles,
  Tags,
  Wand2,
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

export function InboxFeaturePage() {
  return (
    <>
      <PageHead page="inbox" />
      <main>
        <InboxHero />
        <EverythingInOnePlace />
        <CaptureSources />
        <AICluster />
        <FilingFlow />
        <StructureSection />
        <WorksWithRest />
        <UseCases />
        <MoreFeatures />
        <InboxFaq />
        <FinalCta />
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

function InboxHero() {
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
          <Eyebrow>Inbox</Eyebrow>
          <h1 className="mt-4 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
            Capture first.
            <br />
            <span className="italic text-terracotta">Organize later.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            A contemplative space for processing what comes in. Quick capture, voice memos, web
            clips, PDF extraction, and smart filing. All on your device.
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
          <HeroInboxMock />
        </motion.div>
      </Container>
    </section>
  )
}

function HeroInboxMock() {
  return (
    <FeatureHeroScreenshot
      screenshot="inbox"
      alt="memrynote inbox page showing captured notes, source metadata, and the processing queue"
      width={1608}
      height={944}
    />
  )
}

const ANCHOR_CARDS = [
  {
    icon: Zap,
    title: 'Quick capture',
    body: 'A global hotkey omnibox grabs links, voice, files, and text. Two keystrokes from anywhere.'
  },
  {
    icon: Mic,
    title: 'Voice & audio',
    body: 'Record a thought and memrynote transcribes it automatically. Audio file stays beside the text.'
  },
  {
    icon: Scissors,
    title: 'Web & PDF clips',
    body: 'Drag a PDF or paste a URL. memrynote pulls title, hero image, OCR text, and source link.'
  },
  {
    icon: Brain,
    title: 'Smart filing',
    body: 'Suggestions learn where you usually file. Confirm with one key, or pick a different home.'
  }
] as const

function EverythingInOnePlace() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>One funnel, every source</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Everything you grab.
            <br />
            One quiet place to triage it.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Articles, voice memos, screenshots, PDFs, social posts. They all land in Inbox with full
            source context and a single review flow.
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

function CaptureSources() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Capture surfaces</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Three ways in.
            <br />
            <span className="italic text-terracotta">Zero friction out.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            A keyboard-first omnibox, a system-wide drop zone, and a clipper for the things you find
            on the web. Pick the one closest to your hand.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.1fr_0.9fr_0.9fr]">
          <HotkeyOmniboxMock />
          <ClipperMock />
          <DropZoneMock />
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

const omniboxItems: { icon: LucideIcon; label: string; hint: string; active?: boolean }[] = [
  { icon: Link2, label: 'Capture URL from clipboard', hint: '↵', active: true },
  { icon: Mic, label: 'Start voice memo', hint: 'V' },
  { icon: FileText, label: 'New plain note', hint: 'N' },
  { icon: ImageIcon, label: 'Paste screenshot', hint: '⌘V' },
  { icon: Clock, label: 'Snooze last capture', hint: 'S' }
]

function HotkeyOmniboxMock() {
  return (
    <SurfaceCard
      label="Hotkey omnibox"
      title="Press ⌘⇧I. Anywhere."
      body="A global capture window over whatever you're looking at. No app switch, no lost context."
    >
      <div className="rounded-xl border border-border/60 bg-paper p-1.5 shadow-inner">
        <div className="flex items-center gap-2 px-3 pb-2 pt-2">
          <Zap className="h-3.5 w-3.5 text-terracotta" strokeWidth={2} />
          <span className="font-mono-accent text-[11px] tracking-wide text-muted">
            Capture something...
          </span>
        </div>
        <ul className="space-y-0.5 border-t border-border/40 pt-1">
          {omniboxItems.map((item) => (
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

function ClipperMock() {
  return (
    <SurfaceCard
      label="Link & PDF capture"
      title="Drop a link. Get the page."
      body="Paste a URL or drop a PDF. memrynote extracts title, description, hero image, favicon, and OCR'd body."
    >
      <div className="space-y-3">
        <div className="overflow-hidden rounded-xl border border-border/60 bg-paper">
          <div className="flex items-center gap-2 border-b border-border/50 bg-paper-alt/60 px-3 py-2">
            <span className="h-4 w-4 rounded bg-terracotta/20" />
            <span className="truncate font-mono-accent text-[11px] text-muted">
              arxiv.org/abs/2205.06175
            </span>
          </div>
          <div className="px-4 py-3">
            <p className="font-serif text-[15px] text-ink">A Generalist Agent</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              A single agent that plays Atari, captions images, chats, stacks blocks with a real
              robot arm...
            </p>
            <p className="mt-2 font-mono-accent text-[11px] text-muted">
              DeepMind · S. Reed et al.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-paper px-3 py-2.5">
          <FileCode className="h-4 w-4 text-terracotta" strokeWidth={1.8} />
          <span className="flex-1 truncate text-[13px] text-ink/85">lease-agreement.pdf</span>
          <span className="font-mono-accent text-[11px] text-sage">OCR ready</span>
        </div>
      </div>
    </SurfaceCard>
  )
}

function DropZoneMock() {
  return (
    <SurfaceCard
      label="Drag & drop"
      title="Anything from Finder."
      body="Files, screenshots, recordings. Drop them on the memrynote icon or into the Inbox window."
    >
      <div className="rounded-xl border-2 border-dashed border-terracotta/35 bg-terracotta/5 px-4 py-7 text-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-terracotta/12 text-terracotta">
          <Layers className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <p className="mt-4 font-serif text-base text-ink">Drop to capture</p>
        <p className="mt-1 text-[12px] text-muted">PDF, MD, image, audio, video</p>
        <div className="mt-4 flex flex-wrap justify-center gap-1.5">
          {['.pdf', '.png', '.m4a', '.mp4', '.md'].map((ext) => (
            <span
              key={ext}
              className="rounded-full border border-border/60 bg-card px-2 py-0.5 font-mono-accent text-[10px] text-muted"
            >
              {ext}
            </span>
          ))}
        </div>
      </div>
    </SurfaceCard>
  )
}

function AICluster() {
  return (
    <section className="relative bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Smart grouping</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Patterns surface themselves.
            <br />
            <span className="italic text-terracotta">Local model, on your device.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            memrynote groups related captures, suggests tags, and offers a snooze when you need
            quiet. Every model runs locally. Nothing leaves your laptop.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          <ClusterPanelMock />
          <div className="grid gap-5">
            <TagSuggestionsMock />
            <SnoozeMock />
          </div>
        </div>
      </Container>
    </section>
  )
}

const clusters = [
  {
    title: 'Reading · AI papers',
    count: 5,
    preview: 'A Generalist Agent · Toolformer · Chain-of-Thought · ...',
    tone: 'terracotta' as const
  },
  {
    title: 'Trip · Lisbon 2026',
    count: 3,
    preview: 'Hotel confirmation · Belém walking tour · Pastel de nata list',
    tone: 'sage' as const
  },
  {
    title: 'PKM tools',
    count: 4,
    preview: 'Logseq vs memrynote · Obsidian dataview · Heptabase canvas...',
    tone: 'amber' as const
  }
]

const clusterToneClass: Record<(typeof clusters)[number]['tone'], string> = {
  terracotta: 'bg-terracotta/10 text-terracotta',
  sage: 'bg-sage/15 text-sage',
  amber: 'bg-amber-500/15 text-amber-700'
}

function ClusterPanelMock() {
  return (
    <motion.article
      {...fadeUp}
      className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-7 shadow-card md:p-9"
    >
      <Eyebrow>Suggested groups</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">
        12 captures. <span className="italic text-terracotta">3 themes.</span>
      </h3>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
        When AI is on, memrynote reads titles and content, then proposes groupings. File the whole
        cluster at once or break it apart. Local-first by design — see the AI roadmap for the full
        model story.
      </p>

      <ul className="mt-7 space-y-3">
        {clusters.map((c) => (
          <li
            key={c.title}
            className="flex items-center gap-4 rounded-xl border border-border/55 bg-paper-alt/55 px-4 py-3"
          >
            <span
              className={cn(
                'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                clusterToneClass[c.tone]
              )}
            >
              <Sparkles className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-serif text-base text-ink">
                {c.title}
                <span className="rounded-full bg-paper px-2 py-0.5 font-mono-accent text-[10px] text-muted">
                  {c.count}
                </span>
              </p>
              <p className="mt-0.5 truncate text-[12px] text-muted">{c.preview}</p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-full border border-border/60 bg-card px-3 py-1 font-mono-accent text-[11px] text-ink/80 hover:bg-paper-alt"
            >
              File all
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-5 rounded-lg bg-paper-alt/60 px-3 py-2 font-mono-accent text-[11px] text-muted">
        Suggestions are advisory. You decide what stays grouped.
      </p>
    </motion.article>
  )
}

const TAG_SUGGESTIONS = [
  { label: '#ai-papers', tone: 'terracotta' as const },
  { label: '#reading', tone: 'sage' as const },
  { label: '#research', tone: 'terracotta' as const },
  { label: '#agents', tone: 'amber' as const }
]

const TAG_SUGGESTION_TONE_CLASS: Record<(typeof TAG_SUGGESTIONS)[number]['tone'], string> = {
  terracotta: 'border-terracotta/30 bg-terracotta/8 text-terracotta',
  sage: 'border-sage/30 bg-sage/10 text-sage',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-700'
}

function TagSuggestionsMock() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <Eyebrow>Tag suggestions</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">Tags before you file.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        memrynote proposes tags based on content. Accept with a tap, or type your own.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {TAG_SUGGESTIONS.map((tag) => (
          <span
            key={tag.label}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-accent text-[12px]',
              TAG_SUGGESTION_TONE_CLASS[tag.tone]
            )}
          >
            <Hash className="h-3 w-3" strokeWidth={2} />
            {tag.label.replace('#', '')}
          </span>
        ))}
        <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border/70 bg-paper px-2.5 py-1 font-mono-accent text-[12px] text-muted">
          + add
        </span>
      </div>
    </motion.article>
  )
}

const SNOOZE_OPTIONS = [
  { label: 'Later today', meta: '18:00' },
  { label: 'Tomorrow morning', meta: 'Sat 09:00' },
  { label: 'Next week', meta: 'Mon, May 25' },
  { label: 'Pick a date', meta: '…' }
]

function SnoozeMock() {
  return (
    <motion.article
      {...fadeUp}
      className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
    >
      <Eyebrow>Snooze</Eyebrow>
      <h3 className="mt-3 font-serif text-2xl text-ink">Not now is a feature.</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Push an item out of view with a reason. It returns at the right time, with the note
        attached.
      </p>
      <div className="mt-5 overflow-hidden rounded-xl border border-border/60 bg-paper">
        <ul className="divide-y divide-border/40">
          {SNOOZE_OPTIONS.map((o, i) => (
            <li
              key={o.label}
              className={cn(
                'flex items-center justify-between gap-3 px-4 py-2.5 text-sm',
                i === 1 ? 'bg-terracotta/8 text-terracotta' : 'text-ink/85'
              )}
            >
              <span className="flex items-center gap-2.5">
                <MoonStar className="h-3.5 w-3.5" strokeWidth={1.8} />
                {o.label}
              </span>
              <span className="font-mono-accent text-[11px] text-muted">{o.meta}</span>
            </li>
          ))}
        </ul>
      </div>
    </motion.article>
  )
}

const FILING_DESTINATIONS = [
  { icon: FileText, label: 'Note' },
  { icon: FolderOpen, label: 'Folder' },
  { icon: CheckSquare, label: 'Task' },
  { icon: Archive, label: 'Archive' },
  { icon: MoonStar, label: 'Snooze' }
] as const

function FilingFlow() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.2fr]">
          <motion.div {...fadeUp}>
            <Eyebrow>Filing</Eyebrow>
            <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
              Filing is one
              <br />
              <span className="italic text-terracotta">keypress away.</span>
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
              Every captured item has the same five destinations. The order learns from you. The
              source link, original file, and metadata travel along with it.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {FILING_DESTINATIONS.map((d) => (
                <span
                  key={d.label}
                  className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm text-ink/85 shadow-sm"
                >
                  <d.icon className="h-3.5 w-3.5 text-terracotta" strokeWidth={1.8} />
                  {d.label}
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
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-terracotta/12 text-terracotta">
                <Link2 className="h-4 w-4" strokeWidth={1.8} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-base text-ink">
                  A Generalist Agent — DeepMind
                </p>
                <p className="font-mono-accent text-[11px] text-muted">
                  arxiv.org · captured 6m ago
                </p>
              </div>
              <span className="font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
                F
              </span>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-border/60 bg-paper">
              <p className="px-4 py-2 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
                File to...
              </p>
              <ul className="divide-y divide-border/40">
                <li className="flex items-center justify-between gap-3 bg-terracotta/8 px-4 py-2.5 text-sm text-terracotta">
                  <span className="flex items-center gap-2.5">
                    <FolderOpen className="h-4 w-4" strokeWidth={1.8} />
                    research / ai-agents
                  </span>
                  <span className="font-mono-accent text-[11px]">↵</span>
                </li>
                <li className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-ink/85">
                  <span className="flex items-center gap-2.5">
                    <FileText className="h-4 w-4" strokeWidth={1.8} />
                    new note · &ldquo;Generalist agents&rdquo;
                  </span>
                  <span className="font-mono-accent text-[11px] text-muted">⇧↵</span>
                </li>
                <li className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-ink/85">
                  <span className="flex items-center gap-2.5">
                    <CheckSquare className="h-4 w-4" strokeWidth={1.8} />
                    task · &ldquo;Read this weekend&rdquo;
                  </span>
                  <span className="font-mono-accent text-[11px] text-muted">T</span>
                </li>
                <li className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-ink/85">
                  <span className="flex items-center gap-2.5">
                    <Archive className="h-4 w-4" strokeWidth={1.8} />
                    archive
                  </span>
                  <span className="font-mono-accent text-[11px] text-muted">A</span>
                </li>
              </ul>
            </div>
            <p className="mt-5 rounded-lg bg-paper-alt/60 px-3 py-2 font-mono-accent text-[11px] text-muted">
              Suggestions reorder based on past filing choices.
            </p>
          </motion.div>
        </div>
      </Container>
    </section>
  )
}

const STRUCTURE_CARDS = [
  {
    icon: MoonStar,
    title: 'Snooze',
    body: 'Push an item out with a reason and a return time. Custom snoozes for any moment.'
  },
  {
    icon: FolderOpen,
    title: 'File & archive',
    body: 'Send captures to a note, folder, or task. Archive when an item is done, not gone.'
  },
  {
    icon: Tags,
    title: 'Tag suggestions',
    body: 'memrynote proposes tags from content. Confirm, swap, or write your own before filing.'
  },
  {
    icon: Layers,
    title: 'Bulk actions',
    body: 'Select a cluster and file, tag, or snooze the whole group in one motion.'
  },
  {
    icon: BarChart3,
    title: 'Inbox insights',
    body: 'A heatmap of when you capture, type distribution, and how fast you process the queue.'
  },
  {
    icon: Link2,
    title: 'Source preserved',
    body: 'Every capture keeps its origin — URL, author, EXIF, timestamps — for the long haul.'
  }
] as const

function StructureSection() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Structure</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Tools to make Inbox empty.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Snooze, archive, bulk actions, and a heatmap that tells you when you actually process.
            All optional. All keyboard.
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
    icon: FileText,
    title: 'Into Notes',
    body: 'File a capture to a note in any folder. Source URL and metadata move along with it.'
  },
  {
    icon: Calendar,
    title: 'Onto Calendar',
    body: 'Turn an article or voice memo into a task with a date. It plots itself on your week.'
  },
  {
    icon: PenLine,
    title: 'In Journal',
    body: 'Surface today’s captures inside the day context strip while you write your entry.'
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
            Inbox is the funnel. Notes, Calendar, and Journal are where things land — same vault,
            same shortcuts, same offline storage.
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

const USE_CASES_LIST = [
  {
    icon: Layers,
    title: 'Knowledge workers',
    body: 'Bookmarks, Slack pastes, PDFs. One place that holds the day until you can think.'
  },
  {
    icon: Sparkles,
    title: 'ADHD brains',
    body: 'Catch the thought before it leaves. Snooze the rest with a reason you trust future-you to read.'
  },
  {
    icon: GraduationCap,
    title: 'Researchers',
    body: 'Web clips with full source context, EXIF, and OCR. Cite-ready when you process them.'
  },
  {
    icon: PenLine,
    title: 'Writers',
    body: 'Voice memos transcribed inline. Half-formed lines stay until you pick one and run with it.'
  }
] as const

function UseCases() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Use cases</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for the buffer.
          </h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {USE_CASES_LIST.map((u) => (
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
    icon: Mic,
    title: 'Voice transcription',
    body: 'Recordings transcribe to editable text. Audio stays beside the transcript, both portable.'
  },
  {
    icon: ImageIcon,
    title: 'EXIF metadata',
    body: 'Captured images keep camera, location, and timestamp data when present.'
  },
  {
    icon: Wand2,
    title: 'OCR fallback',
    body: 'PDFs and screenshots get text extraction so they’re searchable, not buried.'
  },
  {
    icon: Clock,
    title: 'Custom snooze',
    body: 'Pick a date, an hour, or a relative window. Add a one-line reason.'
  },
  {
    icon: Archive,
    title: 'Archive view',
    body: 'Processed items keep around for the audit trail without cluttering the queue.'
  },
  {
    icon: FileVideo,
    title: 'Video & audio files',
    body: 'Drop in recordings, podcasts, or screen captures. Metadata tracked.'
  }
] as const

function MoreFeatures() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>And more</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Wait, there&apos;s more.
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

const INBOX_FAQ = [
  {
    question: 'Where do captured items live?',
    answer:
      'In your vault, on your device. Each capture is a record in the local memrynote database with the original file alongside it. Sync between your own devices is end-to-end encrypted. Nothing is ever uploaded to a third-party service for processing.'
  },
  {
    question: 'How does voice transcription work?',
    answer:
      'Record a memo and memrynote produces an editable transcript automatically when transcription is enabled. The audio file is preserved as an attachment so you can re-listen at any time. The full local-model speech pipeline is on the AI roadmap.'
  },
  {
    question: 'Is filing private? Does any data leave my machine?',
    answer:
      'Your captures live in your vault on your device. Sync between your own devices is end-to-end encrypted. AI-assisted filing is optional, and the AI Agent roadmap is built around BYOK and local models — see the AI Agent page for the architectural plan.'
  },
  {
    question: 'Can I import existing items into Inbox?',
    answer:
      'Yes. Drag a folder of PDFs, images, or markdown files onto the Inbox window and they become inbox items with metadata preserved. You can also paste URLs in bulk and memrynote will extract each page.'
  },
  {
    question: 'What happens to snoozed items?',
    answer:
      'They disappear from the active queue until the snooze time. When they return, the original capture is intact, including the snooze reason and the source link, so you remember why future-you wanted to see it.'
  }
]

function InboxFaq() {
  return (
    <section className="border-t border-border/40 bg-paper-alt/35 py-24">
      <Container size="sm">
        <motion.div {...fadeUp} className="mb-12 text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-4xl">
            Inbox, answered.
          </h2>
        </motion.div>

        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <Accordion type="single" collapsible className="w-full">
            {INBOX_FAQ.map((item, i) => (
              <AccordionItem
                key={item.question}
                value={`inbox-faq-${i}`}
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

function FinalCta() {
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_55%)]"
      />
      <Container size="md">
        <motion.div {...fadeUp} className="text-center">
          <h2 className="mx-auto max-w-2xl font-serif text-4xl font-normal leading-tight text-ink text-balance md:text-5xl">
            Everything you capture <span className="italic text-terracotta">finds its place.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Local-first. End-to-end encrypted. A folder you own, with a queue that empties on your
            terms.
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

          <div className="mt-10 flex items-center justify-center gap-2 font-mono-accent text-[11px] uppercase tracking-[0.22em] text-muted">
            <Keyboard className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>⌘ ⇧ I anywhere</span>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
