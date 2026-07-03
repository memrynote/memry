import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Globe,
  Inbox,
  Link2,
  Lock,
  MousePointerClick,
  ScanText,
  type LucideIcon
} from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { FeatureHeroScreenshot } from '@/components/shared/FeatureHeroScreenshot'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

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

export function WebClipperFeaturePage() {
  return (
    <>
      <PageHead page="webClipper" />
      <main>
        <ClipperHero />
        <HowItWorks />
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

function ReviewPill({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 font-mono-accent uppercase tracking-[0.22em] text-amber-700 ' +
        (size === 'sm' ? 'px-2.5 py-1 text-[10px]' : 'px-3 py-1.5 text-[11px]')
      }
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500 motion-safe:animate-pulse" />
      In review by Google &amp; Firefox
    </span>
  )
}

// Official browser logos live in public/browsers/*.svg.
const BROWSERS: { logo: string; name: string; store: string }[] = [
  { logo: '/browsers/chrome.svg', name: 'Chrome', store: 'Chrome Web Store' },
  { logo: '/browsers/firefox.svg', name: 'Firefox', store: 'Firefox Add-ons' },
  { logo: '/browsers/edge.svg', name: 'Edge', store: 'Edge Add-ons' }
]

function BrowserCards() {
  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: '-60px' }}
      className="mx-auto mt-12 grid max-w-3xl gap-4 sm:grid-cols-3"
    >
      {BROWSERS.map((b) => (
        <motion.article
          key={b.name}
          variants={fadeUpVariant}
          className="flex flex-col items-center rounded-2xl border border-border/60 bg-card p-6 text-center shadow-card"
        >
          <img src={b.logo} alt={`${b.name} logo`} width={40} height={40} className="h-10 w-10" />
          <h3 className="mt-4 font-serif text-xl text-ink">{b.name}</h3>
          <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-muted">
            <CheckCircle2 className="h-3.5 w-3.5 text-amber-600" strokeWidth={2} />
            In review · {b.store}
          </p>
        </motion.article>
      ))}
    </motion.div>
  )
}

function ClipperHero() {
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
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-terracotta/30 bg-terracotta/10 px-2.5 py-1 font-mono-accent text-[10px] uppercase tracking-[0.28em] text-terracotta">
              <Globe className="h-3 w-3" strokeWidth={2} />
              Web Clipper
            </span>
            <ReviewPill size="md" />
          </div>
          <h1 className="mt-5 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
            Clip and save
            <br />
            <span className="italic text-terracotta">any link.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg">
            One click sends the page, its readable text, and the URL straight to your memrynote
            Inbox. No copy-paste, no lost tabs. Read it later, file it, or turn it into a task — all
            in a vault you own.
          </p>

          <div className="mt-9 flex justify-center">
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

          <p className="mt-12 font-mono-accent text-[11px] uppercase tracking-[0.28em] text-muted">
            Built and working · waiting on the stores
          </p>
        </motion.div>

        <BrowserCards />

        <motion.div
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
          className="mt-14"
        >
          <FeatureHeroScreenshot
            screenshot="inbox"
            alt="memrynote Inbox showing clipped web pages and links captured from the browser"
            width={1232}
            height={870}
          />
        </motion.div>
      </Container>
    </section>
  )
}

const CLIP_CARDS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: MousePointerClick,
    title: 'One click, any page',
    body: 'Pin the extension and clip whatever you are reading — article, docs, a random link. It captures the title, URL, and content.'
  },
  {
    icon: ScanText,
    title: 'Readable, not raw',
    body: 'The clipper strips the noise and keeps the article. What lands in your vault is clean text you can actually re-read.'
  },
  {
    icon: Inbox,
    title: 'Straight to your Inbox',
    body: 'Every clip arrives in the memrynote Inbox. Read later, file into a folder, or convert it into a task — on your schedule.'
  },
  {
    icon: Lock,
    title: 'Private by default',
    body: 'Clips talk to your local app over loopback and sync end-to-end encrypted. The page you saved is nobody else’s business.'
  }
]

function HowItWorks() {
  return (
    <section className="bg-paper-alt/55 py-24 md:py-28">
      <Container>
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Save the web.
            <br />
            Keep the signal.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            The clipper pairs with the memrynote desktop app. Install it in your browser, click
            once, and the link is yours — offline, searchable, and linkable like any other note.
          </p>
        </motion.div>

        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-60px' }}
          className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          {CLIP_CARDS.map((card) => (
            <motion.article
              key={card.title}
              variants={fadeUpVariant}
              className="flex flex-col rounded-2xl border border-border/60 bg-card p-6 shadow-card transition-shadow hover:shadow-elevated"
            >
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
                <card.icon className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <h3 className="mt-5 font-serif text-xl text-ink">{card.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">{card.body}</p>
            </motion.article>
          ))}
        </motion.div>
      </Container>
    </section>
  )
}

function FinalCta() {
  return (
    <section className="border-t border-border/50 bg-paper-alt/40 py-24 md:py-28">
      <Container size="md">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <Eyebrow>Get set up</Eyebrow>
          <h2 className="mt-3 font-serif text-3xl font-normal leading-tight text-ink md:text-5xl">
            Install memrynote now.
            <br />
            Clip the web the day it ships.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            The clipper pairs with the desktop app. Set up your vault today and the browser
            extension slots right in as soon as Google and Firefox finish their review.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button size="lg" className="rounded-full px-7" asChild>
              <Link to="/download/desktop">
                Download memrynote
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-6 text-ink hover:bg-paper-alt"
              asChild
            >
              <Link to="/roadmap">
                See the roadmap
                <Link2 className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </motion.div>
      </Container>
    </section>
  )
}
