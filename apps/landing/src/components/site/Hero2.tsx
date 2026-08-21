import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { ArrowRight, Check, Copy, Play } from 'lucide-react'
import { Link } from 'react-router'
import heroBg from '@/assets/hero-bg.png'
import { Mascot } from '@/components/ui/mascot'
import { HeroDemoDialog } from '@/components/site/HeroDemoDialog'
import { DownloadPill } from '@/components/shared/DownloadCTA'
import { trackLandingEvent } from '@/lib/analytics'
import { useDetectedOS } from '@/lib/download'

// Same cask the install guide documents (apps/docs/src/guide/install.md).
const BREW_COMMAND = 'brew install --cask memrynote/tap/memry'

const EASE = [0.16, 1, 0.3, 1] as const

// One synchronized entrance — every hero layer (copy, CTAs, screenshot)
// shares this transition so the whole hero materializes at once, not in a stagger.
const HERO_IN = { duration: 0.7, delay: 0.1, ease: EASE }

/**
 * The hero screenshot, and the two numbers that govern the whole hero.
 *
 * `cssWidth` is the box the shot renders in. Its height follows the capture's aspect,
 * and that height IS the hero panel's height budget — the copy block above it is nearly
 * fixed, so the panel lands at roughly 530px + cssWidth / aspect. Widen this and the
 * hero grows past the fold on a tall display; that regression is the whole reason the
 * numbers are pinned here instead of inline.
 *
 * Retina rule: rendering at N CSS px needs a capture of at least 2N real px, or the
 * browser upscales and the app UI goes soft. `width` below is the capture's real pixel
 * width, so the pixel-perfect ceiling is always `width / 2`.
 *
 * Current capture is 1448px wide → ceiling 724px, and we render well past it, because
 * a shot too small to read is a worse hero than a slightly soft one. The room this costs
 * is bought back by the tight pt/mt above, not by shrinking the shot. To get big AND
 * sharp the capture must get wider — and to stay inside the fold it must also get
 * shorter, i.e. resize the app window short-and-wide before capturing, don't crop after.
 * Target: ~2400x1200 real px (2:1) → cssWidth 1100 renders pixel-perfect at 550px tall.
 */
/* The painted sky is nearly white at the top (its own mean is rgb(228 238 244)), so the
   hero read as pale grey rather than sky. This wash deepens the blue where the headline
   sits and fades out before the treeline, leaving the landscape's greens untouched. */
const HERO_SKY_WASH =
  'linear-gradient(to bottom, rgb(122 168 214 / 0.42) 0%, rgb(132 176 218 / 0.24) 40%, rgb(140 182 220 / 0.08) 62%, transparent 78%)'

const HERO_SHOT = { src: '/screenshots/hero_white.png', width: 1448, height: 954 } as const
const HERO_SHOT_CSS_WIDTH = '58rem'

/**
 * Silent loop revealed under the cursor on hover. `preload="none"` keeps it off the
 * hero's paint budget entirely — the first byte is fetched on the first hover — and
 * the poster is the still itself, so the mask sweeping open before the data lands
 * shows the same pixels instead of a black hole.
 */
const HERO_VIDEO = '/demos/InboxVoice.mp4'
const REVEAL_HIDDEN = -18
const REVEAL_FULL = 125
const REVEAL_MS = 750

// Scroll-linked screenshot growth. The window lands at full size — the first paint is
// already the "grown" state, because the shot is the reason people are here and it should
// never open set back and small. Scrolling then pushes it PAST full size, so the gesture
// still pays off instead of just undoing a shrink. Reversible, because it's mapped off
// scroll position, not a one-shot animation. Ends at 0.45 of the hero's scroll range so
// it peaks while still on screen, not after it has left.
const SHOT_SCALE_FROM = 1
const SHOT_SCALE_TO = 1.06
const SHOT_SCALE_RANGE = [0, 0.45]

/**
 * Sticker chip inside the hero headline — hand-drawn mascot + italic word on a
 * pastel pill. Everything is em-sized so the chip scales with display-hero's
 * clamp()ed font size. The mascot is ink-on-transparent (paper shows through),
 * so it sits straight on the pill — no color tile. Its empty alt keeps it
 * decorative, so screen readers hear the plain sentence.
 */
function HeadlineChip({
  mascotSrc,
  pillClassName,
  children
}: {
  mascotSrc: string
  pillClassName: string
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-[0.12em] whitespace-nowrap rounded-[0.32em] border border-ink/5 ps-[0.16em] pe-[0.26em] py-[0.08em] align-middle shadow-card ${pillClassName}`}
    >
      <Mascot src={mascotSrc} className="size-[0.95em] shrink-0" />
      <span className="italic">{children}</span>
    </span>
  )
}

/** Homebrew one-liner, click to copy. Only surfaces for visitors on macOS. */
function BrewInstall() {
  const os = useDetectedOS()
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    },
    []
  )

  if (os !== 'mac') return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(BREW_COMMAND)
    } catch {
      return // clipboard blocked (insecure context / denied) — leave the text selectable
    }
    trackLandingEvent('landing_download_click', 'download:brew:hero')
    setCopied(true)
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="mt-5 flex justify-center">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy the Homebrew command: ${BREW_COMMAND}`}
        className="inline-flex max-w-full items-center gap-2.5 rounded-xl border border-white/60 bg-white/45 py-2 ps-3.5 pe-2.5 text-start backdrop-blur-sm transition-colors duration-200 hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
      >
        {/* Wraps rather than truncates: a half-shown shell command is unreadable. */}
        <code className="break-all font-mono text-[12px] leading-4 text-muted">
          <span aria-hidden className="select-none text-muted/60">
            ${' '}
          </span>
          {BREW_COMMAND}
        </code>
        {copied ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-terracotta" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0 text-muted/70" aria-hidden />
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Homebrew command copied' : ''}
      </span>
    </div>
  )
}

export function Hero2() {
  const shot = HERO_SHOT
  const [demoOpen, setDemoOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const maskRef = useRef<HTMLSpanElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const pauseTimer = useRef<number | null>(null)
  const reduceMotion = useReducedMotion()

  useEffect(
    () => () => {
      if (pauseTimer.current !== null) window.clearTimeout(pauseTimer.current)
    },
    []
  )

  // Pointer position as a percentage of the shot, written straight onto the mask's
  // gradient origin. Swapped while --reveal is parked at an extreme, so it never jumps.
  const setRevealOrigin = (event: React.PointerEvent<HTMLElement>) => {
    const mask = maskRef.current
    if (!mask) return
    const rect = mask.getBoundingClientRect()
    mask.style.setProperty('--ox', `${((event.clientX - rect.left) / rect.width) * 100}%`)
    mask.style.setProperty('--oy', `${((event.clientY - rect.top) / rect.height) * 100}%`)
  }

  // Touch fires pointerenter on tap; there the tap should only open the lightbox.
  const hoverCapable = () =>
    typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches

  const openReveal = (event: React.PointerEvent<HTMLElement>) => {
    if (reduceMotion || !hoverCapable()) return
    if (pauseTimer.current !== null) window.clearTimeout(pauseTimer.current)
    setRevealOrigin(event)
    maskRef.current?.style.setProperty('--reveal', String(REVEAL_FULL))
    void videoRef.current?.play().catch(() => {
      // Autoplay refused (power saving, or the file is still loading) — the poster
      // matches the still underneath, so the reveal degrades to a no-op.
    })
  }

  const closeReveal = (event: React.PointerEvent<HTMLElement>) => {
    if (reduceMotion || !hoverCapable()) return
    setRevealOrigin(event)
    maskRef.current?.style.setProperty('--reveal', String(REVEAL_HIDDEN))
    if (pauseTimer.current !== null) window.clearTimeout(pauseTimer.current)
    pauseTimer.current = window.setTimeout(() => videoRef.current?.pause(), REVEAL_MS)
  }

  // 0 at rest, 1 once the hero panel has scrolled past the top of the viewport.
  const { scrollYProgress } = useScroll({
    target: panelRef,
    offset: ['start start', 'end start']
  })
  const shotScale = useTransform(
    scrollYProgress,
    SHOT_SCALE_RANGE,
    [SHOT_SCALE_FROM, SHOT_SCALE_TO],
    { clamp: true }
  )

  return (
    <section id="hero">
      {/* The illustrated sky mega-panel — full-bleed: no inset, no radius, no border, so
          the wallpaper runs edge to edge and the fixed nav pill floats straight on it.
          The panel takes its natural content height, and that height is deliberately
          budgeted to land near 1090px on desktop: short enough that the section below
          peeks above the fold on a tall display, instead of the hero eating the screen.
          The budget is spent by pt-32 + the copy block + the screenshot's max-w — change
          any one of them and the fold moves. */}
      <div ref={panelRef} className="relative w-full overflow-hidden bg-tint-sky pb-8 md:pb-10">
        {/* Painted landscape backdrop — a whisper of blur pushes it back so the copy + app
            window read as the foreground; scale-105 hides the soft edges the blur would
            otherwise fade at the panel border. */}
        <img
          src={heroBg}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full scale-105 object-cover blur-[3px]"
        />

        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: HERO_SKY_WASH }}
        />

        {/* The page's dot grid + grain, re-painted over the sky so the texture carries
            through the hero instead of stopping where the wallpaper starts. Above the
            backdrop, below the copy and the screenshot (both z-10). */}
        <div aria-hidden className="page-texture pointer-events-none absolute inset-0" />

        {/* Copy + CTAs */}
        <div className="relative z-10 px-6 pt-28 text-center sm:px-10 md:pt-28">
          {/* Type geometry from the Paper slogan artboard: 54px cap, -0.055em tracking,
              105% leading, centered. The base h1 rule in index.css is unlayered, so it
              outranks plain utilities — leading/tracking need the important modifier. */}
          <motion.h1
            className="mx-auto max-w-4xl text-balance font-serif text-[clamp(2.125rem,4.6vw,3.375rem)] font-normal leading-[1.05]! tracking-[-0.055em]! text-ink"
            initial={{ opacity: 0, y: 18, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={HERO_IN}
          >
            Your{' '}
            {/* nowrap keeps the comma glued to the pill — atomic inlines invite a wrap right after */}
            <span className="whitespace-nowrap">
              <HeadlineChip
                mascotSrc="/mascots/thoughts.png"
                pillClassName="-rotate-2 bg-tint-sky text-[#2e5a78]"
              >
                thoughts
              </HeadlineChip>
              ,
            </span>
            <br className="hidden sm:block" /> beautifully{' '}
            <HeadlineChip
              mascotSrc="/mascots/organized.png"
              pillClassName="rotate-2 bg-tint-peach text-terracotta-dark"
            >
              organized
            </HeadlineChip>
          </motion.h1>

          <motion.p
            className="mx-auto mt-[34px] max-w-[760px] text-[17px] leading-[1.65] text-muted"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
          >
            Offline-first. End-to-end encrypted. Free forever. Yours.
          </motion.p>

          <motion.div
            className="mt-6 flex flex-col items-center justify-center gap-4 sm:flex-row sm:gap-[30px]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
          >
            <DownloadPill location="hero" />
            <Link
              to="/pricing"
              onClick={() => trackLandingEvent('landing_nav_click', 'pricing:hero')}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[14px] px-4 text-[14px] font-medium leading-[18px] text-ink transition-colors duration-200 hover:bg-ink/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
            >
              See pricing
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
          >
            <BrewInstall />
          </motion.div>
        </div>

        {/* App screenshot — flat and whole. No perspective tilt: that 3D transform
            rasterized the high-res capture soft (the "blurry" look); flat renders it crisp.
            No translate/overflow bleed either, so the full window is shown, nothing trimmed
            off the bottom — it sits warm in the sky, whole.
            Width comes from HERO_SHOT_CSS_WIDTH; see that comment before changing it. */}
        <motion.div
          className="relative z-10 mx-auto mt-8 w-[88%]"
          initial={{ y: 72 }}
          animate={{ y: 0 }}
          transition={HERO_IN}
          style={{ maxWidth: HERO_SHOT_CSS_WIDTH, scale: reduceMotion ? 1 : shotScale }}
        >
          {/* The whole window is the demo trigger — click opens the video lightbox.
              It's also the glass mat: the padding band IS the effect — the sky shows
              through it, frosted, so the shot sits in the panel instead of on it. The inner white line is an inset box-shadow rather
              than `ring-inset`, which leaves `ring-*` free for the focus ring.
              Opacity animates HERE, not on the wrapper: an ancestor at opacity < 1 becomes
              a backdrop root, which would leave the glass flat for the whole entrance and
              snap it in at the end. An element's own opacity doesn't suppress its own
              backdrop-filter. Hover lift stays transform-only — crisp, and safe for glass. */}
          <motion.button
            type="button"
            aria-label="Watch the MemryNote demo"
            onClick={() => {
              trackLandingEvent('landing_hero_demo_open', 'hero')
              setDemoOpen(true)
            }}
            onPointerEnter={openReveal}
            onPointerLeave={closeReveal}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={HERO_IN}
            className="group relative block w-full rounded-2xl border border-white/50 bg-white/20 p-[clamp(10px,1.4vw,22px)] shadow-[0_24px_60px_rgba(31,41,55,0.30),inset_0_0_0_1px_rgba(255,255,255,0.35)] backdrop-blur-md transition-transform duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/70 motion-safe:group-hover:-translate-y-2 motion-safe:group-hover:scale-[1.02]"
          >
            <div className="relative overflow-hidden rounded-xl bg-white">
              <img
                src={shot.src}
                alt="The MemryNote app showing a note with tags, a table, and tasks"
                width={shot.width}
                height={shot.height}
                loading="eager"
                decoding="async"
                className="block h-auto w-full"
              />
              {/* Mask geometry lives in index.css — see .product-shot-video. */}
              <span ref={maskRef} className="product-shot-video" aria-hidden>
                <video ref={videoRef} muted loop playsInline preload="none" poster={shot.src}>
                  <source src={HERO_VIDEO} type="video/mp4" />
                </video>
              </span>
            </div>
            {/* Watch cue — always on, never hover-gated: it's the only sign the shot is a
                video. Light glass pill with a filled play disc, per the Paper Play chip. */}
            {/* z-2: the reveal layer is z-1, and equal-DOM-order does not save an
                auto-z sibling from a positioned one that declares a stack level. */}
            <span className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center">
              <span className="flex items-center gap-2.5 rounded-full bg-white/85 py-2 ps-2 pe-5 shadow-[0_18px_50px_rgb(0_0_0/0.18)] backdrop-blur-md transition-transform duration-300 ease-out motion-safe:group-hover:scale-105 motion-safe:group-focus-visible:scale-105">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-terracotta shadow-[0_8px_22px_rgb(255_103_26/0.45)]">
                  <Play
                    className="h-3.5 w-3.5 translate-x-[2px] fill-white text-white"
                    strokeWidth={0}
                    aria-hidden
                  />
                </span>
                <span className="text-[14px] font-medium leading-[18px] text-ink">Watch demo</span>
              </span>
            </span>
          </motion.button>
        </motion.div>
      </div>

      <HeroDemoDialog open={demoOpen} onClose={() => setDemoOpen(false)} />
    </section>
  )
}
