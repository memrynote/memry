import { motion } from 'motion/react'
import {
  ArrowRight,
  CheckCircle2,
  Download,
  FileText,
  FolderOpen,
  Github,
  HardDrive,
  Lock,
  Search,
  Shield,
  Sparkles,
  WifiOff
} from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { FeatureHeroScreenshot } from '@/components/shared/FeatureHeroScreenshot'
import { PageHead } from '@/components/shared/PageHead'
import { Faq } from '@/components/site/Faq'
import { FinalCta } from '@/components/site/FinalCta'
import { PageHero } from '@/components/site/PageHero'
import { Button } from '@/components/ui/button'
import { GITHUB_URL } from '@/lib/constants'
import { SITE_TINTS } from '@/lib/site-tints'
import { cn } from '@/lib/utils'
import { trackLandingEvent } from '@/lib/analytics'
import { DownloadButton } from '@/components/shared/DownloadCTA'
import { downloadHref, useDetectedOS, type DetectedOS, type DownloadPlatform } from '@/lib/download'

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

export function DownloadDesktopPage() {
  const detected = useDetectedOS()
  return (
    <>
      <PageHead page="downloadDesktop" />
      <main>
        <DesktopHero />
        <PlatformGrid detected={detected} />
        <WhyDesktop />
        <InAction />
        <WorksWithEverything />
        <InstallSteps />
        <ReleaseChannel />
        <Faq eyebrow="FAQ" title="Before you download." items={DOWNLOAD_FAQ} />
        <FinalCta
          title={
            <>
              Your second brain, <span className="italic text-terracotta">on your machine.</span>
            </>
          }
          sub="Free, local, open source. Download memrynote and pick a vault in under a minute."
          location="download-final"
          secondary={{
            label: 'Security architecture',
            to: '/security',
            event: 'download:security'
          }}
        />
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

/** Open source · encrypted · free — the three claims that ride under the hero CTAs. */
function TrustDots() {
  return (
    <div className="mb-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/80">
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
        Free forever
      </span>
    </div>
  )
}

function DesktopHero() {
  return (
    <PageHero
      tint={SITE_TINTS.downloadDesktop}
      eyebrow={
        <>
          <Download className="h-3 w-3" strokeWidth={2} />
          Desktop app · Available now
        </>
      }
      title={
        <>
          memrynote for <span className="italic text-terracotta">Desktop.</span>
        </>
      }
      sub="A local-first PKM that lives on your machine. Free, open source, and available for macOS, Windows, and Linux."
      actions={
        <>
          <DownloadButton location="download-hero" className="px-7" />
          <Button
            size="lg"
            variant="ghost"
            className="rounded-full px-6 text-ink hover:bg-ink/5"
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
        </>
      }
      visual={
        <>
          <TrustDots />
          <DesktopNoteScreenshot />
        </>
      }
    />
  )
}

function DesktopNoteScreenshot() {
  return (
    <FeatureHeroScreenshot
      screenshot="notes"
      alt="memrynote notes page in the desktop app"
      width={1232}
      height={870}
      className="max-w-4xl"
    />
  )
}

interface PlatformDownload {
  key: DownloadPlatform
  label: string
}

interface PlatformInfo {
  id: 'mac' | 'windows' | 'linux'
  label: string
  versionTag: string
  primary: PlatformDownload
  secondary?: PlatformDownload
}

// Real brand marks (simple-icons), 24px viewBox, solid fill via currentColor.
const PLATFORM_LOGO: Record<PlatformInfo['id'], string> = {
  mac: 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701',
  windows:
    'M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623',
  linux:
    'M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139zm.529 3.405h.013c.213 0 .396.062.584.198.19.135.33.332.438.533.105.259.158.459.166.724 0-.02.006-.04.006-.06v.105a.086.086 0 01-.004-.021l-.004-.024a1.807 1.807 0 01-.15.706.953.953 0 01-.213.335.71.71 0 00-.088-.042c-.104-.045-.198-.064-.284-.133a1.312 1.312 0 00-.22-.066c.05-.06.146-.133.183-.198.053-.128.082-.264.088-.402v-.02a1.21 1.21 0 00-.061-.4c-.045-.134-.101-.2-.183-.333-.084-.066-.167-.132-.267-.132h-.016c-.093 0-.176.03-.262.132a.8.8 0 00-.205.334 1.18 1.18 0 00-.09.4v.019c.002.089.008.179.02.267-.193-.067-.438-.135-.607-.202a1.635 1.635 0 01-.018-.2v-.02a1.772 1.772 0 01.15-.768c.082-.22.232-.406.43-.533a.985.985 0 01.594-.2zm-2.962.059h.036c.142 0 .27.048.399.135.146.129.264.288.344.465.09.199.14.4.153.667v.004c.007.134.006.2-.002.266v.08c-.03.007-.056.018-.083.024-.152.055-.274.135-.393.2.012-.09.013-.18.003-.267v-.015c-.012-.133-.04-.2-.082-.333a.613.613 0 00-.166-.267.248.248 0 00-.183-.064h-.021c-.071.006-.13.04-.186.132a.552.552 0 00-.12.27.944.944 0 00-.023.33v.015c.012.135.037.2.08.334.046.134.098.2.166.268.01.009.02.018.034.024-.07.057-.117.07-.176.136a.304.304 0 01-.131.068 2.62 2.62 0 01-.275-.402 1.772 1.772 0 01-.155-.667 1.759 1.759 0 01.08-.668 1.43 1.43 0 01.283-.535c.128-.133.26-.2.418-.2zm1.37 1.706c.332 0 .733.065 1.216.399.293.2.523.269 1.052.468h.003c.255.136.405.266.478.399v-.131a.571.571 0 01.016.47c-.123.31-.516.643-1.063.842v.002c-.268.135-.501.333-.775.465-.276.135-.588.292-1.012.267a1.139 1.139 0 01-.448-.067 3.566 3.566 0 01-.322-.198c-.195-.135-.363-.332-.612-.465v-.005h-.005c-.4-.246-.616-.512-.686-.71-.07-.268-.005-.47.193-.6.224-.135.38-.271.483-.336.104-.074.143-.102.176-.131h.002v-.003c.169-.202.436-.47.839-.601.139-.036.294-.065.466-.065zm2.8 2.142c.358 1.417 1.196 3.475 1.735 4.473.286.534.855 1.659 1.102 3.024.156-.005.33.018.513.064.646-1.671-.546-3.467-1.089-3.966-.22-.2-.232-.335-.123-.335.59.534 1.365 1.572 1.646 2.757.13.535.16 1.104.021 1.67.067.028.135.06.205.067 1.032.534 1.413.938 1.23 1.537v-.043c-.06-.003-.12 0-.18 0h-.016c.151-.467-.182-.825-1.065-1.224-.915-.4-1.646-.336-1.77.465-.008.043-.013.066-.018.135-.068.023-.139.053-.209.064-.43.268-.662.669-.793 1.187-.13.533-.17 1.156-.205 1.869v.003c-.02.334-.17.838-.319 1.35-1.5 1.072-3.58 1.538-5.348.334a2.645 2.645 0 00-.402-.533 1.45 1.45 0 00-.275-.333c.182 0 .338-.03.465-.067a.615.615 0 00.314-.334c.108-.267 0-.697-.345-1.163-.345-.467-.931-.995-1.788-1.521-.63-.4-.986-.87-1.15-1.396-.165-.534-.143-1.085-.015-1.645.245-1.07.873-2.11 1.274-2.763.107-.065.037.135-.408.974-.396.751-1.14 2.497-.122 3.854a8.123 8.123 0 01.647-2.876c.564-1.278 1.743-3.504 1.836-5.268.048.036.217.135.289.202.218.133.38.333.59.465.21.201.477.335.876.335.039.003.075.006.11.006.412 0 .73-.134.997-.268.29-.134.52-.334.74-.4h.005c.467-.135.835-.402 1.044-.7zm2.185 8.958c.037.6.343 1.245.882 1.377.588.134 1.434-.333 1.791-.765l.211-.01c.315-.007.577.01.847.268l.003.003c.208.199.305.53.391.876.085.4.154.78.409 1.066.486.527.645.906.636 1.14l.003-.007v.018l-.003-.012c-.015.262-.185.396-.498.595-.63.401-1.746.712-2.457 1.57-.618.737-1.37 1.14-2.036 1.191-.664.053-1.237-.2-1.574-.898l-.005-.003c-.21-.4-.12-1.025.056-1.69.176-.668.428-1.344.463-1.897.037-.714.076-1.335.195-1.814.12-.465.308-.797.641-.984l.045-.022zm-10.814.049h.01c.053 0 .105.005.157.014.376.055.706.333 1.023.752l.91 1.664.003.003c.243.533.754 1.064 1.189 1.637.434.598.77 1.131.729 1.57v.006c-.057.744-.48 1.148-1.125 1.294-.645.135-1.52.002-2.395-.464-.968-.536-2.118-.469-2.857-.602-.369-.066-.61-.2-.723-.4-.11-.2-.113-.602.123-1.23v-.004l.002-.003c.117-.334.03-.752-.027-1.118-.055-.401-.083-.71.043-.94.16-.334.396-.4.69-.533.294-.135.64-.202.915-.47h.002v-.002c.256-.268.445-.601.668-.838.19-.201.38-.336.663-.336zm7.159-9.074c-.435.201-.945.535-1.488.535-.542 0-.97-.267-1.28-.466-.154-.134-.28-.268-.373-.335-.164-.134-.144-.333-.074-.333.109.016.129.134.199.2.096.066.215.2.36.333.292.2.68.467 1.167.467.485 0 1.053-.267 1.398-.466.195-.135.445-.334.648-.467.156-.136.149-.267.279-.267.128.016.034.134-.147.332a8.097 8.097 0 01-.69.468zm-1.082-1.583V5.64c-.006-.02.013-.042.029-.05.074-.043.18-.027.26.004.063 0 .16.067.15.135-.006.049-.085.066-.135.066-.055 0-.092-.043-.141-.068-.052-.018-.146-.008-.163-.065zm-.551 0c-.02.058-.113.049-.166.066-.047.025-.086.068-.14.068-.05 0-.13-.02-.136-.068-.01-.066.088-.133.15-.133.08-.031.184-.047.259-.005.019.009.036.03.03.05v.02h.003z'
}

function PlatformLogo({ id, className }: { id: PlatformInfo['id']; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d={PLATFORM_LOGO[id]} />
    </svg>
  )
}

const PLATFORMS: PlatformInfo[] = [
  {
    id: 'mac',
    label: 'macOS',
    versionTag: 'macOS 11+',
    primary: { key: 'mac-arm64', label: 'Apple Silicon' },
    secondary: { key: 'mac-x64', label: 'Intel' }
  },
  {
    id: 'windows',
    label: 'Windows',
    versionTag: 'Windows 10+',
    primary: { key: 'windows', label: '.exe' }
  },
  {
    id: 'linux',
    label: 'Linux',
    versionTag: 'Ubuntu / Fedora',
    primary: { key: 'linux', label: '.AppImage' },
    secondary: { key: 'linux-deb', label: '.deb' }
  }
]

function PlatformGrid({ detected }: { detected: DetectedOS }) {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container size="md">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Pick your platform</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Three platforms. <span className="italic text-terracotta">One vault.</span>
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Signed builds with automatic updates. Pick yours.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mx-auto mt-14 grid max-w-xl gap-x-6 gap-y-12 sm:grid-cols-3"
        >
          {PLATFORMS.map((p) => (
            <PlatformPick key={p.id} platform={p} highlighted={detected === p.id} />
          ))}
        </motion.div>

        <p className="mt-12 text-center font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70">
          Automatic updates keep you current. Source stays open on GitHub.
        </p>
      </Container>
    </section>
  )
}

function PlatformPick({ platform, highlighted }: { platform: PlatformInfo; highlighted: boolean }) {
  const { primary, secondary } = platform
  return (
    <motion.div variants={fadeUpVariant} className="flex flex-col items-center text-center">
      <PlatformLogo
        id={platform.id}
        className={cn('h-9 w-9', highlighted ? 'text-terracotta' : 'text-ink')}
      />
      <h3 className="mt-4 flex items-center gap-2 font-serif text-xl text-ink">
        {platform.label}
        {highlighted && (
          <span className="font-mono-accent text-[10px] uppercase tracking-[0.16em] text-terracotta">
            Detected
          </span>
        )}
      </h3>
      <p className="mt-1 font-mono-accent text-[11px] uppercase tracking-[0.16em] text-muted">
        {platform.versionTag}
      </p>
      <a
        href={downloadHref(primary.key)}
        onClick={() =>
          trackLandingEvent('landing_download_click', `download:${primary.key}:platform`)
        }
        className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-terracotta transition-colors hover:text-terracotta/80"
      >
        <Download className="h-4 w-4" strokeWidth={2} />
        Download {primary.label}
      </a>
      {secondary && (
        <a
          href={downloadHref(secondary.key)}
          onClick={() =>
            trackLandingEvent('landing_download_click', `download:${secondary.key}:platform`)
          }
          className="mt-2 text-xs text-muted transition-colors hover:text-terracotta"
        >
          or {secondary.label}
        </a>
      )}
    </motion.div>
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

const INSTALL_STEPS = [
  {
    number: '01',
    title: 'Download',
    body: 'Grab the installer for your platform. Signed builds for macOS, Windows, and Linux.'
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
              Live <span className="italic text-terracotta">now.</span>
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">
              Signed macOS, Windows, and Linux builds are available now, with automatic updates. The
              source stays open.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <DownloadButton location="release-channel" size="default" className="px-5" />
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
              'Desktop installers target macOS, Windows, and Linux',
              'Automatic updates keep every platform current'
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
      'memrynote checks for updates automatically and installs signed desktop releases in the background. Your vault folder stays untouched between updates.'
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
