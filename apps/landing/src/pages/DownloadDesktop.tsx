import { useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Apple,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CheckSquare,
  ChevronRight,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Github,
  HardDrive,
  Hash,
  Inbox,
  Lock,
  MonitorSmartphone,
  Package,
  Search,
  Shield,
  Sparkles,
  Terminal,
  WifiOff,
  type LucideIcon
} from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { GITHUB_RELEASES_URL, GITHUB_URL } from '@/lib/constants'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { trackLandingEvent } from '@/lib/analytics'

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

type DetectedOS = 'mac' | 'windows' | 'linux' | null

function detectOS(): DetectedOS {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent
  if (/Mac/i.test(ua)) return 'mac'
  if (/Win/i.test(ua)) return 'windows'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return null
}

const subscribeOS = () => () => {}
const getServerOS = (): DetectedOS => null

function useDetectedOS(): DetectedOS {
  return useSyncExternalStore(subscribeOS, detectOS, getServerOS)
}

function downloadTarget(label: string) {
  return `download:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

export function DownloadDesktopPage() {
  const detected = useDetectedOS()
  return (
    <>
      <PageHead page="downloadDesktop" />
      <main>
        <DesktopHero detected={detected} />
        <PlatformGrid detected={detected} />
        <WhyDesktop />
        <InAction />
        <WorksWithEverything />
        <SystemRequirements />
        <InstallSteps />
        <ReleaseChannel />
        <DownloadFaq />
        <DownloadFinalCta detected={detected} />
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

const OS_LABEL: Record<Exclude<DetectedOS, null>, string> = {
  mac: 'macOS',
  windows: 'Windows',
  linux: 'Linux'
}

function DesktopHero({ detected }: { detected: DetectedOS }) {
  const platform = detected ?? 'mac'
  const label = OS_LABEL[platform]
  return (
    <section className="relative overflow-hidden pt-32 pb-16 md:pt-40 md:pb-20">
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
          <span className="inline-flex items-center gap-2 font-mono-accent text-[11px] uppercase tracking-[0.28em] text-muted">
            <Download className="h-3 w-3" strokeWidth={2} />
            Download · Desktop
          </span>
          <h1 className="mt-4 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
            memrynote for <span className="italic text-terracotta">Desktop.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            A local-first PKM that lives on your machine. Free forever for the local app. macOS,
            Windows, and Linux.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-full px-7" asChild>
              <a
                href={GITHUB_RELEASES_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => trackLandingEvent('landing_download_click', downloadTarget(label))}
              >
                <Download className="h-4 w-4" />
                {detected ? `Download for ${label}` : 'Download memrynote'}
              </a>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-6 text-ink hover:bg-paper-alt"
              asChild
            >
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => trackLandingEvent('landing_external_click', 'download:github')}
              >
                <Github className="h-4 w-4" />
                View on GitHub
              </a>
            </Button>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/80">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-sage" />
              Open source
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-terracotta" />
              End-to-end encrypted sync
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              Preview release
            </span>
          </div>
        </motion.div>

        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
          className="mt-14"
        >
          <DesktopAppMock />
        </motion.div>
      </Container>
    </section>
  )
}

function DesktopAppMock() {
  return (
    <div className="relative mx-auto max-w-4xl">
      <div className="absolute -inset-x-12 -bottom-10 -top-6 -z-10 rounded-[40px] bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_70%)]" />
      <div className="overflow-hidden rounded-[26px] border border-border/60 bg-card shadow-[0_30px_80px_-30px_rgba(31,41,55,0.3)]">
        <div className="flex items-center justify-between gap-3 border-b border-border/50 bg-paper-alt px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#FFBD2E]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28CA41]" />
          </div>
          <div className="flex items-center gap-2 font-mono-accent text-[11px] uppercase tracking-[0.16em] text-muted">
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span>kaan&apos;s vault</span>
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <span className="font-mono-accent text-[10px] uppercase tracking-[0.18em] text-muted/70">
              Local
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-sage" />
          </div>
        </div>

        <div className="grid grid-cols-[200px_1fr] md:grid-cols-[220px_1fr_220px]">
          <aside className="border-e border-border/40 bg-paper-alt/50 px-4 py-5">
            <p className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
              Workspace
            </p>
            <ul className="mt-4 space-y-1 text-[13px]">
              {[
                { icon: Inbox, label: 'Inbox', count: 12 },
                { icon: BookOpen, label: 'Journal', count: null },
                { icon: FileText, label: 'Notes', count: 248, active: true },
                { icon: CheckSquare, label: 'Tasks', count: 17 },
                { icon: Hash, label: 'Tags', count: null }
              ].map((item) => (
                <li
                  key={item.label}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5',
                    item.active
                      ? 'bg-terracotta/12 text-terracotta'
                      : 'text-ink/85 hover:bg-paper-alt/80'
                  )}
                >
                  <span className="flex items-center gap-2">
                    <item.icon className="h-4 w-4" strokeWidth={1.8} />
                    {item.label}
                  </span>
                  {item.count != null && (
                    <span className="font-mono-accent text-[11px] text-muted/80">{item.count}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-6 rounded-xl border border-border/55 bg-card px-3 py-3">
              <p className="font-mono-accent text-[9px] uppercase tracking-[0.22em] text-muted">
                Sync
              </p>
              <p className="mt-1.5 flex items-center gap-2 text-[12px] text-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-sage" />
                Up to date
              </p>
              <p className="mt-0.5 text-[11px] text-muted">2 minutes ago</p>
            </div>
          </aside>

          <section className="px-6 py-7 md:px-9 md:py-10">
            <div className="mb-3 flex items-center gap-2 text-[12px] text-muted">
              <span>Notes</span>
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
              <span>research</span>
              <ChevronRight className="h-3 w-3" strokeWidth={2} />
              <span className="text-ink">second-brain.md</span>
            </div>
            <h2 className="font-serif text-2xl text-ink md:text-3xl">
              Second brain, first principles
            </h2>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1 rounded-full border border-terracotta/30 bg-terracotta/8 px-2 py-0.5 font-mono-accent text-terracotta">
                #pkm
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-sage/30 bg-sage/10 px-2 py-0.5 font-mono-accent text-sage">
                #writing
              </span>
              <span className="font-mono-accent uppercase tracking-[0.16em] text-muted">
                · Updated 14:02
              </span>
            </div>
            <div className="mt-5 space-y-3 text-[14px] leading-relaxed text-ink/85">
              <p>
                Notes are plain{' '}
                <code className="rounded bg-paper-alt px-1.5 py-0.5 font-mono-accent text-[12px] text-terracotta">
                  .md
                </code>{' '}
                files in a folder you own. The app reads, the file system stores. Portable forever.
              </p>
              <p>
                Wiki-links create the graph. Backlinks show the references. Properties give every
                note its shape.
              </p>
              <ul className="ps-2 space-y-1.5">
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[5px] border border-terracotta bg-terracotta">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-2.5 w-2.5 text-white"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="4"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span className="text-ink/55 line-through">Open source on GitHub</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[5px] border border-ink/25" />
                  <span>End-to-end encrypted device sync</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[5px] border border-ink/25" />
                  <span>Mobile app — late 2026</span>
                </li>
              </ul>
            </div>
          </section>

          <aside className="hidden border-s border-border/40 bg-paper-alt/40 px-4 py-5 md:block">
            <p className="font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
              Outline
            </p>
            <ul className="mt-4 space-y-2 text-[12px] text-muted">
              <li className="text-ink">Second brain, first principles</li>
              <li className="ps-3">Why plain markdown</li>
              <li className="ps-3">Wiki-links and the graph</li>
              <li className="ps-3">Properties</li>
            </ul>
            <p className="mt-6 font-mono-accent text-[10px] uppercase tracking-[0.22em] text-muted">
              Backlinks · 3
            </p>
            <ul className="mt-3 space-y-2 text-[12px] text-muted">
              <li>
                <p className="font-medium text-ink">Working with files</p>
                <p className="mt-0.5">…see [[second-brain]]…</p>
              </li>
              <li>
                <p className="font-medium text-ink">2026 reading list</p>
                <p className="mt-0.5">Inspired by [[second-brain]]…</p>
              </li>
            </ul>
          </aside>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/40 bg-paper-alt/60 px-4 py-2 font-mono-accent text-[10px] uppercase tracking-[0.16em] text-muted">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <Search className="h-3 w-3" strokeWidth={2} />
              <span>⌘P</span>
            </span>
            <span className="flex items-center gap-1.5">
              <FileText className="h-3 w-3" strokeWidth={2} />
              <span>248 notes · 1.2 GB</span>
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-sage" />
            <span>v0.18 · Stable</span>
          </span>
        </div>
      </div>
    </div>
  )
}

interface PlatformInfo {
  id: 'mac' | 'windows' | 'linux'
  label: string
  icon: LucideIcon
  versionTag: string
  arches: string[]
  formats: string[]
}

const PLATFORMS: PlatformInfo[] = [
  {
    id: 'mac',
    label: 'macOS',
    icon: Apple,
    versionTag: 'macOS 11+',
    arches: ['Apple Silicon', 'Intel'],
    formats: ['.dmg', '.zip']
  },
  {
    id: 'windows',
    label: 'Windows',
    icon: MonitorSmartphone,
    versionTag: 'Windows 10+',
    arches: ['x64'],
    formats: ['.exe', 'installer']
  },
  {
    id: 'linux',
    label: 'Linux',
    icon: Terminal,
    versionTag: 'Ubuntu 20.04+ / Fedora 36+',
    arches: ['x64'],
    formats: ['AppImage', '.deb', '.rpm']
  }
]

function PlatformGrid({ detected }: { detected: DetectedOS }) {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Pick your platform</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Three platforms. <span className="italic text-terracotta">One vault.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            All builds are open source on GitHub. Pick the one for your machine.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 md:grid-cols-3"
        >
          {PLATFORMS.map((p) => (
            <PlatformCard key={p.id} platform={p} highlighted={detected === p.id} />
          ))}
        </motion.div>

        <p className="mt-8 text-center font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70">
          Latest binaries land on GitHub Releases. Verify checksums before install.
        </p>
      </Container>
    </section>
  )
}

function PlatformCard({ platform, highlighted }: { platform: PlatformInfo; highlighted: boolean }) {
  return (
    <motion.article
      variants={fadeUpVariant}
      className={cn(
        'relative flex h-full flex-col overflow-hidden rounded-2xl border bg-card p-7 shadow-card transition-all',
        highlighted
          ? 'border-terracotta/40 shadow-[0_20px_60px_-30px_rgba(255,103,26,0.45)]'
          : 'border-border/60'
      )}
    >
      {highlighted && (
        <span className="absolute end-5 top-5 inline-flex items-center gap-1 rounded-full bg-terracotta/12 px-2.5 py-0.5 font-mono-accent text-[10px] uppercase tracking-[0.18em] text-terracotta">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-terracotta" />
          Detected
        </span>
      )}
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-paper-alt/80 text-ink">
        <platform.icon className="h-6 w-6" strokeWidth={1.6} />
      </span>
      <h3 className="mt-5 font-serif text-2xl text-ink">{platform.label}</h3>
      <p className="mt-1 font-mono-accent text-[11px] uppercase tracking-[0.16em] text-muted">
        {platform.versionTag}
      </p>

      <div className="mt-6 space-y-2 text-[13px]">
        <div className="flex items-center gap-2">
          <Cpu className="h-3.5 w-3.5 text-muted" strokeWidth={2} />
          <span className="text-muted">Arch:</span>
          <span className="text-ink">{platform.arches.join(', ')}</span>
        </div>
        <div className="flex items-center gap-2">
          <Package className="h-3.5 w-3.5 text-muted" strokeWidth={2} />
          <span className="text-muted">Formats:</span>
          <span className="font-mono-accent text-ink">{platform.formats.join(' · ')}</span>
        </div>
      </div>

      <div className="mt-auto pt-7">
        <Button
          size="lg"
          variant={highlighted ? 'default' : 'outline'}
          className={cn(
            'w-full rounded-full',
            highlighted
              ? 'bg-terracotta text-white shadow-[0_16px_34px_-14px_rgba(255,103,26,0.7)] hover:bg-terracotta-dark'
              : 'border-ink/15 bg-paper-alt/40 text-ink hover:bg-paper-alt'
          )}
          asChild
        >
          <a
            href={GITHUB_RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            onClick={() =>
              trackLandingEvent('landing_download_click', downloadTarget(platform.label))
            }
          >
            <Download className="h-4 w-4" />
            Download for {platform.label}
          </a>
        </Button>
      </div>
    </motion.article>
  )
}

const WHY_DESKTOP = [
  {
    icon: WifiOff,
    title: 'Offline-first',
    body: 'Your vault lives on your disk. Open it on a plane. No spinners while the cloud thinks.'
  },
  {
    icon: Lock,
    title: 'End-to-end encrypted',
    body: 'When you turn sync on, XChaCha20-Poly1305 encrypts every byte before it leaves your machine. Server never sees plaintext.'
  },
  {
    icon: FolderOpen,
    title: 'Plain markdown vault',
    body: 'Every note is a .md file in a folder you own. Read it in any editor. Portable forever.'
  },
  {
    icon: Github,
    title: 'Open source',
    body: 'Read the code, file the bug, submit the PR. The desktop app is built in the open.'
  }
] as const

function WhyDesktop() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Why desktop</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Your second brain. <span className="italic text-terracotta">On your machine.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            A native window for serious work. Local-first, encrypted, open source.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {WHY_DESKTOP.map((card) => (
            <motion.article
              key={card.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
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

const ACTION_FEATURES = [
  {
    icon: Search,
    title: 'Command palette',
    body: '⌘P jumps to anything. Notes, tasks, journal entries, settings.'
  },
  {
    icon: FileText,
    title: 'Tabs and split panes',
    body: 'Open as many notes as you want. Split vertically or horizontally. Drag tabs between panes.'
  },
  {
    icon: HardDrive,
    title: 'Full-text search',
    body: 'SQLite FTS5 indexes your whole vault. Results in milliseconds.'
  }
] as const

function InAction() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>In action</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Built for the keyboard.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Command palette, full-text search, tabs, split panes. Everything reachable in one
            keystroke.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 md:grid-cols-3"
        >
          {ACTION_FEATURES.map((f) => (
            <motion.article
              key={f.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                <f.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-4 font-serif text-xl text-ink">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const WORKS_WITH = [
  {
    icon: Sparkles,
    title: 'Any sync service',
    body: 'Your vault is a folder. Sync it with iCloud, Dropbox, Syncthing, Git, or just leave it local.'
  },
  {
    icon: Github,
    title: 'Open source code',
    body: 'Read the repo, file an issue, submit a PR. Built in the open from day one.'
  },
  {
    icon: Shield,
    title: 'memrynote Sync (optional)',
    body: 'Turn on E2E-encrypted sync between your own devices when you want it. Pay nothing for the local app.'
  }
] as const

function WorksWithEverything() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Works with everything</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Yours forever. <span className="italic text-terracotta">No lock-in.</span>
          </h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-3"
        >
          {WORKS_WITH.map((w) => (
            <motion.article
              key={w.title}
              variants={fadeUpVariant}
              className="rounded-2xl border border-border/60 bg-card p-6 shadow-card"
            >
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sage/12 text-sage">
                <w.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-4 font-serif text-xl text-ink">{w.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{w.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

const REQUIREMENTS: { platform: string; os: string; arch: string; ram: string; disk: string }[] = [
  {
    platform: 'macOS',
    os: '11.0 Big Sur or later',
    arch: 'Apple Silicon · Intel',
    ram: '4 GB',
    disk: '300 MB + vault'
  },
  {
    platform: 'Windows',
    os: 'Windows 10 (64-bit) or later',
    arch: 'x64',
    ram: '4 GB',
    disk: '300 MB + vault'
  },
  {
    platform: 'Linux',
    os: 'Ubuntu 20.04 · Fedora 36 · Debian 11 or newer',
    arch: 'x64',
    ram: '4 GB',
    disk: '300 MB + vault'
  }
]

function SystemRequirements() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container size="md">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>System requirements</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Modest needs.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            memrynote runs on machines you already own. Built on Electron, sized like a small app.
          </p>
        </motion.div>

        <motion.div
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.1 }}
          className="mt-12 overflow-x-auto rounded-2xl border border-border/55 bg-white/55 shadow-card"
        >
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-border/60 bg-paper-alt/40">
                <th className="px-6 py-4 text-start font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
                  Platform
                </th>
                <th className="px-5 py-4 text-start font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
                  Minimum OS
                </th>
                <th className="px-5 py-4 text-start font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
                  Architecture
                </th>
                <th className="px-5 py-4 text-start font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
                  RAM
                </th>
                <th className="px-5 py-4 text-start font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted">
                  Disk
                </th>
              </tr>
            </thead>
            <tbody>
              {REQUIREMENTS.map((row) => (
                <tr
                  key={row.platform}
                  className="border-b border-border/40 last:border-0 transition-colors hover:bg-paper-alt/40"
                >
                  <td className="px-6 py-4 text-sm font-medium text-ink">{row.platform}</td>
                  <td className="px-5 py-4 text-sm text-ink/85">{row.os}</td>
                  <td className="px-5 py-4 text-sm text-ink/85">{row.arch}</td>
                  <td className="px-5 py-4 text-sm text-ink/85">{row.ram}</td>
                  <td className="px-5 py-4 text-sm text-ink/85">{row.disk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </motion.div>
      </Container>
    </section>
  )
}

const INSTALL_STEPS = [
  {
    number: '01',
    title: 'Download',
    body: 'Grab the installer for your platform from GitHub Releases. Verify the SHA-256 if you like.'
  },
  {
    number: '02',
    title: 'Open',
    body: 'Double-click the installer. macOS: drag to Applications. Windows: run the .exe. Linux: chmod and launch.'
  },
  {
    number: '03',
    title: 'Pick a vault',
    body: 'Create a new folder or point memrynote at an existing markdown folder (Obsidian vaults work directly).'
  }
] as const

function InstallSteps() {
  return (
    <section className="py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Get started</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Three steps to your vault.
          </h2>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 md:grid-cols-3"
        >
          {INSTALL_STEPS.map((step, i) => (
            <motion.article
              key={step.number}
              variants={fadeUpVariant}
              className="relative rounded-2xl border border-border/60 bg-card p-7 shadow-card"
            >
              <span className="font-mono-accent text-[11px] uppercase tracking-[0.22em] text-terracotta">
                Step {step.number}
              </span>
              <h3 className="mt-3 font-serif text-2xl text-ink">{step.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-muted">{step.body}</p>
              {i < INSTALL_STEPS.length - 1 && (
                <span className="absolute end-0 top-1/2 hidden -translate-y-1/2 translate-x-1/2 md:inline-flex">
                  <ArrowRight className="h-5 w-5 text-border" strokeWidth={1.5} />
                </span>
              )}
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

function ReleaseChannel() {
  return (
    <section className="bg-paper-alt/55 py-20 md:py-24">
      <Container size="md">
        <motion.div
          {...fadeUp}
          className="grid gap-8 rounded-3xl border border-border/55 bg-card p-8 shadow-card md:grid-cols-[1.2fr_1fr] md:items-center md:p-10"
        >
          <div>
            <Eyebrow>Release channel</Eyebrow>
            <h2 className="mt-3 font-serif text-3xl text-ink md:text-4xl">
              Currently <span className="italic text-terracotta">in Preview.</span>
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
              Releases land on GitHub. Pre-production app, no backward-compat constraints yet —
              expect breaking changes between minor versions. Stable channel arrives with late 2026
              launch.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button variant="default" className="rounded-full px-5" asChild>
                <a
                  href={GITHUB_RELEASES_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() =>
                    trackLandingEvent('landing_download_click', 'download:latest-release')
                  }
                >
                  Latest release
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
              <Button
                variant="ghost"
                className="rounded-full px-5 text-ink hover:bg-paper-alt"
                asChild
              >
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() =>
                    trackLandingEvent('landing_external_click', 'download:source-github')
                  }
                >
                  Source on GitHub
                  <Github className="h-4 w-4" />
                </a>
              </Button>
            </div>
          </div>
          <ul className="space-y-3 text-sm">
            {[
              'Open issues against the public repo',
              'Submit PRs through the normal flow',
              'CI builds tagged releases for every platform',
              'CHANGELOG.md ships with every tag'
            ].map((item) => (
              <li key={item} className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-sage" strokeWidth={2} />
                <span className="text-ink/85">{item}</span>
              </li>
            ))}
          </ul>
        </motion.div>
      </Container>
    </section>
  )
}

const DOWNLOAD_FAQ = [
  {
    question: 'Is the desktop app free?',
    answer:
      'Yes. The local app is free forever: notes, tasks, journal, inbox, full-text search, markdown export, no account required. memrynote Sync between your devices is the paid layer.'
  },
  {
    question: 'Is memrynote native or Electron?',
    answer:
      'Electron 39 + React 19. We made the trade-off explicit: cross-platform from day one with one codebase, at the cost of some memory. The vault itself is plain markdown, so the runtime layer never owns your data.'
  },
  {
    question: 'How do I update memrynote?',
    answer:
      'New versions land on GitHub Releases. Download the latest installer and run it. Your vault folder is untouched between updates.'
  },
  {
    question: 'Can I import from Obsidian or Notion?',
    answer:
      'Obsidian vaults open directly — same .md format, same [[wiki-link]] syntax, same frontmatter. Notion exports import as plain markdown.'
  },
  {
    question: 'Is the code signed?',
    answer:
      "macOS and Windows release builds carry developer signatures so the OS gatekeepers don't complain. Linux builds are reproducible from the public source."
  },
  {
    question: 'Where is my data stored?',
    answer:
      'In the vault folder you choose, on your device. Read the full security architecture for the cryptographic details.'
  }
]

function DownloadFaq() {
  return (
    <section className="border-t border-border/40 bg-paper-alt/35 py-24">
      <Container size="sm">
        <motion.div {...fadeUp} className="mb-12 text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-4xl">
            Before you download.
          </h2>
        </motion.div>

        <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
          <Accordion type="single" collapsible className="w-full">
            {DOWNLOAD_FAQ.map((item, i) => (
              <AccordionItem
                key={item.question}
                value={`download-faq-${i}`}
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

function DownloadFinalCta({ detected }: { detected: DetectedOS }) {
  const platform = detected ?? 'mac'
  const label = OS_LABEL[platform]
  return (
    <section className="relative overflow-hidden py-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,103,26,0.10),transparent_55%)]"
      />
      <Container size="md">
        <motion.div {...fadeUp} className="text-center">
          <h2 className="mx-auto max-w-2xl font-serif text-4xl font-normal leading-tight text-ink text-balance md:text-5xl">
            Your vault is waiting. <span className="italic text-terracotta">Ready to start?</span>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-muted leading-relaxed">
            Free, local, open source. Sync between your devices when you want it. Cancel any time.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-full px-8" asChild>
              <a
                href={GITHUB_RELEASES_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() =>
                  trackLandingEvent(
                    'landing_download_click',
                    detected ? downloadTarget(label) : 'download:memry'
                  )
                }
              >
                <Download className="h-4 w-4" />
                {detected ? `Download for ${label}` : 'Download memrynote'}
              </a>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-8 text-ink hover:bg-paper-alt"
              asChild
            >
              <Link
                to="/security"
                onClick={() => trackLandingEvent('landing_nav_click', 'download:security')}
              >
                Security architecture
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
