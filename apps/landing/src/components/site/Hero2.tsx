import { useRef, useState } from 'react'
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { ArrowRight, Play } from 'lucide-react'
import { Link } from 'react-router'
import heroBg from '@/assets/hero-bg.png'
import paperLeft from '@/assets/paper-left.png'
import paperRight from '@/assets/paper-right.png'
import { Button } from '@/components/ui/button'
import { Mascot } from '@/components/ui/mascot'
import { DownloadButton } from '@/components/shared/DownloadCTA'
import { HeroDemoDialog } from '@/components/site/HeroDemoDialog'
import { trackLandingEvent } from '@/lib/analytics'

const EASE = [0.16, 1, 0.3, 1] as const

// One synchronized entrance — every hero layer (copy, CTAs, papers, screenshot)
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
const HERO_SHOT = { src: '/screenshots/hero_white.png', width: 1448, height: 954 } as const
const HERO_SHOT_CSS_WIDTH = '58rem'

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

export function Hero2() {
  const shot = HERO_SHOT
  const [demoOpen, setDemoOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()

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
    <section id="hero" className="px-3 pb-4 pt-3 sm:px-6 md:pb-6">
      {/* The illustrated sky mega-panel — rounded, inset from the viewport edges.
          Top inset matches the nav's pt-3 so the fixed nav pill floats over the wallpaper.
          The panel takes its natural content height, and that height is deliberately
          budgeted to land near 1090px on desktop: short enough that the section below
          peeks above the fold on a tall display, instead of the hero eating the screen.
          The budget is spent by pt-32 + the copy block + the screenshot's max-w — change
          any one of them and the fold moves. */}
      <div
        ref={panelRef}
        className="relative mx-auto w-full overflow-hidden rounded-3xl border border-ink/5 bg-tint-sky pb-8 md:pb-10"
      >
        {/* Painted landscape backdrop — a whisper of blur pushes it back so the copy + app
            window read as the foreground; scale-105 hides the soft edges the blur would
            otherwise fade at the panel border. */}
        <img
          src={heroBg}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full scale-105 object-cover blur-[3px]"
        />

        {/* Copy + CTAs */}
        <div className="relative z-10 px-6 pt-28 text-center sm:px-10 md:pt-28">
          <motion.h1
            className="display-hero mx-auto max-w-4xl text-ink text-balance"
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
            className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted md:text-lg"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
          >
            Offline-first. End-to-end encrypted. Yours.
          </motion.p>

          <motion.div
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={HERO_IN}
          >
            <DownloadButton location="hero" />
            <Button
              size="lg"
              variant="ghost"
              className="rounded-full px-6 text-ink hover:bg-ink/5"
              asChild
            >
              <Link
                to="/pricing"
                onClick={() => trackLandingEvent('landing_nav_click', 'pricing:hero')}
              >
                See pricing
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </motion.div>
        </div>

        {/* Torn-paper collage peeking from behind the app window — desk / note-app vibe.
            Two halves of one sheet, each pinned to its own edge so the lined sheets hug the
            left and the yellow legal pad hugs the right. Nudged below the panel edge (negative
            bottom, clipped by overflow-hidden) so only the tops peek, behind the app window
            (z-5 < z-10). framer-motion owns `transform`, so the push-down uses `bottom`. */}
        <motion.img
          src={paperLeft}
          alt=""
          aria-hidden
          className="pointer-events-none absolute -bottom-8 start-0 z-[5] h-[170px] w-auto select-none sm:-bottom-10 sm:h-[235px] md:-bottom-14 md:h-[300px]"
          initial={{ opacity: 0, y: 44 }}
          animate={{ opacity: 1, y: 0 }}
          transition={HERO_IN}
        />
        <motion.img
          src={paperRight}
          alt=""
          aria-hidden
          className="pointer-events-none absolute -bottom-8 end-0 z-[5] h-[170px] w-auto select-none sm:-bottom-10 sm:h-[235px] md:-bottom-14 md:h-[300px]"
          initial={{ opacity: 0, y: 44 }}
          animate={{ opacity: 1, y: 0 }}
          transition={HERO_IN}
        />

        {/* App screenshot — flat and whole. No perspective tilt: that 3D transform
            rasterized the high-res capture soft (the "blurry" look); flat renders it crisp.
            No translate/overflow bleed either, so the full window is shown, nothing trimmed
            off the bottom — it sits warm in the sky with the papers peeking behind its base.
            Width comes from HERO_SHOT_CSS_WIDTH; see that comment before changing it. */}
        <motion.div
          className="relative z-10 mx-auto mt-8 w-[88%]"
          initial={{ y: 72 }}
          animate={{ y: 0 }}
          transition={HERO_IN}
          style={{ maxWidth: HERO_SHOT_CSS_WIDTH, scale: reduceMotion ? 1 : shotScale }}
        >
          {/* The whole window is the demo trigger — click opens the video lightbox.
              It's also the glass mat: the padding band IS the effect — sky (and the paper
              collage behind its base) shows through it, frosted, so the shot sits in the
              panel instead of on it. The inner white line is an inset box-shadow rather
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
            </div>
            {/* Watch cue — hidden until hover/keyboard focus; always shown on touch (no hover). */}
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="flex translate-y-1 scale-95 items-center gap-2 rounded-full bg-ink/75 px-5 py-2.5 text-sm font-medium text-white opacity-0 shadow-[0_16px_50px_rgba(31,41,55,0.45)] backdrop-blur-md transition-[transform,opacity] duration-200 ease-out group-hover:translate-y-0 group-hover:scale-100 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:scale-100 group-focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:none)]:translate-y-0 [@media(hover:none)]:scale-100 [@media(hover:none)]:opacity-100">
                <Play className="h-4 w-4 fill-current" strokeWidth={1.6} />
                Watch demo
              </span>
            </span>
          </motion.button>
        </motion.div>
      </div>

      <HeroDemoDialog open={demoOpen} onClose={() => setDemoOpen(false)} />
    </section>
  )
}
