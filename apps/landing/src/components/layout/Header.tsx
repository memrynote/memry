import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useNavigate, useLocation } from 'react-router'
import { Menu, X, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { Mascot } from '@/components/ui/mascot'
import { Container } from './Container'
import { BrandGlyph } from './SocialLinks'
import {
  DIRECT_NAV_LINKS,
  DISCORD_URL,
  FEATURE_NAV_GROUPS,
  FEATURE_NAV_ITEMS,
  GITHUB_URL,
  type LandingDropdownItem
} from '@/lib/constants'
import { cn } from '@/lib/utils'
import { scrollToLandingTarget } from '@/lib/smooth-scroll'
import { trackLandingEvent } from '@/lib/analytics'
import { useAuth } from '@/contexts/use-auth'
import { platformForOS, startDownload, useDetectedOS } from '@/lib/download'

/** Rest height of the bar; the dark-section probe reads the page at half of it. */
const BAR_HEIGHT = 64
/** Past this scroll offset the bar takes its frosted surface and drops to 56px. */
const SCROLLED_AT = 8
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

/** Desktop drops the Download link: the Download button covers it (see PrimaryAction). */
const DESKTOP_NAV_LINKS = DIRECT_NAV_LINKS.filter((link) => link.href !== '/download')

function isExternalHref(href: string) {
  return href.startsWith('http')
}

function formatStarCount(count: number) {
  return new Intl.NumberFormat('en-US').format(count)
}

function analyticsTarget(scope: string, label: string) {
  return `${scope}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

type PageContext = {
  /** Content has scrolled under the bar. */
  scrolled: boolean
  /** The hero's own Download row ([data-nav-cta]) is on screen below the bar. */
  heroCtaInView: boolean
  /** A .zone-dark section sits under the bar's midline. */
  overDark: boolean
}

/**
 * What the bar needs to know about the page under it, as a store React can read:
 * measured from the DOM, re-read once per frame while the page scrolls or resizes and
 * whenever the page content is swapped by a navigation.
 *
 * Prerendering has no DOM, so the server snapshot describes a page at its top: the home
 * page opens with its hero Download in view, every other page without one.
 */
function encodeContext(context: PageContext) {
  return [context.scrolled, context.heroCtaInView, context.overDark].map(Number).join('')
}

function decodeContext(snapshot: string): PageContext {
  return {
    scrolled: snapshot[0] === '1',
    heroCtaInView: snapshot[1] === '1',
    overDark: snapshot[2] === '1'
  }
}

function readPageContext() {
  const ctaRect = document.querySelector('[data-nav-cta]')?.getBoundingClientRect()
  return encodeContext({
    scrolled: window.scrollY > SCROLLED_AT,
    heroCtaInView:
      ctaRect !== undefined && ctaRect.bottom > BAR_HEIGHT && ctaRect.top < window.innerHeight,
    overDark: document
      .elementsFromPoint(window.innerWidth / 2, BAR_HEIGHT / 2)
      .some((element) => element.closest('.zone-dark') !== null)
  })
}

function subscribePageContext(onChange: () => void) {
  let frame = 0
  const schedule = () => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      onChange()
    })
  }
  // A navigation replaces the page under <main> without necessarily scrolling.
  const pageSwaps = new MutationObserver(schedule)
  pageSwaps.observe(document.getElementById('main') ?? document.body, {
    childList: true,
    subtree: true
  })
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
  return () => {
    cancelAnimationFrame(frame)
    pageSwaps.disconnect()
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
  }
}

function usePageContext(pathname: string): PageContext {
  const snapshot = useSyncExternalStore(subscribePageContext, readPageContext, () =>
    encodeContext({ scrolled: false, heroCtaInView: pathname === '/', overDark: false })
  )
  return decodeContext(snapshot)
}

type MobileDropdownKey = 'features'

const MOBILE_DROPDOWN_SECTIONS: readonly {
  key: MobileDropdownKey
  label: string
  items: readonly LandingDropdownItem[]
}[] = [{ key: 'features', label: 'Features', items: FEATURE_NAV_ITEMS }] as const

const FEATURE_COLUMNS = FEATURE_NAV_GROUPS.map((group) => ({
  group,
  items: FEATURE_NAV_ITEMS.filter((item) => item.group === group)
}))

const NAV_TEXT =
  'rounded-md text-sm font-medium leading-5 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60'

function NavLink({ href, label }: { href: string; label: string }) {
  const className = cn(NAV_TEXT, 'text-(--nav-body) hover:text-(--nav-ink)')
  const eventName = isExternalHref(href) ? 'landing_external_click' : 'landing_nav_click'

  return isExternalHref(href) ? (
    <a
      href={href}
      className={className}
      onClick={() => trackLandingEvent(eventName, analyticsTarget('nav', label))}
    >
      {label}
    </a>
  ) : (
    <Link
      to={href}
      className={className}
      onClick={() => trackLandingEvent(eventName, analyticsTarget('nav', label))}
    >
      {label}
    </Link>
  )
}

function GitHubLink() {
  const [stars, setStars] = useState<number | null>(null)
  const formattedStars = stars === null ? null : formatStarCount(stars)

  useEffect(() => {
    let active = true

    async function loadStars() {
      try {
        const response = await fetch('/api/github-stars')
        if (!response.ok) return

        const data: unknown = await response.json()
        if (!data || typeof data !== 'object' || !('stars' in data)) return

        const nextStars = data.stars
        if (active && typeof nextStars === 'number' && Number.isFinite(nextStars)) {
          setStars(nextStars)
        }
      } catch {
        // No count is shown when the cached GitHub count is unavailable; the icon still links.
      }
    }

    void loadStars()

    return () => {
      active = false
    }
  }, [])

  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      title="Star on GitHub"
      aria-label={
        formattedStars ? `Star memrynote on GitHub, ${formattedStars} stars` : 'memrynote on GitHub'
      }
      onClick={() => trackLandingEvent('landing_external_click', 'external:github')}
      className={cn(
        NAV_TEXT,
        'inline-flex items-center gap-1.5 text-(--nav-body) hover:text-(--nav-ink)'
      )}
    >
      <BrandGlyph name="GitHub" className="size-4" />
      {formattedStars ? <span className="text-[13px] tabular-nums">{formattedStars}</span> : null}
    </a>
  )
}

function DiscordLink() {
  return (
    <a
      href={DISCORD_URL}
      target="_blank"
      rel="noreferrer"
      title="Join the Discord"
      aria-label="Join the memrynote Discord"
      onClick={() => trackLandingEvent('landing_external_click', 'external:discord')}
      className={cn(NAV_TEXT, 'inline-flex items-center text-(--nav-body) hover:text-(--nav-ink)')}
    >
      <BrandGlyph name="Discord" className="size-[17px]" />
    </a>
  )
}

/**
 * The bar's Download button. While the hero shows its own Download row the bar leaves
 * this out, so a screen never carries two primary actions; it slides in once the hero
 * row scrolls away, and on every page without one.
 */
function PrimaryAction({ visible }: { visible: boolean }) {
  const reduceMotion = useReducedMotion()
  const platform = platformForOS(useDetectedOS())

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        // Width animates on this wrapper and clips the button; the gap lives inside it as
        // padding, so the collapsed wrapper takes no room in the row.
        <motion.div
          key="nav-download"
          className="hidden overflow-hidden md:block"
          initial={{ opacity: 0, width: 0 }}
          animate={{ opacity: 1, width: 'auto' }}
          exit={{
            opacity: 0,
            width: 0,
            transition: { duration: reduceMotion ? 0 : 0.16, ease: EASE_OUT_EXPO }
          }}
          transition={{ duration: reduceMotion ? 0 : 0.24, ease: EASE_OUT_EXPO }}
        >
          <div className="ps-5">
            <Link
              to="/download"
              onClick={() => {
                trackLandingEvent('landing_nav_click', 'nav:download')
                // A detected desktop gets its installer right away, alongside the page.
                // Phones and unknown systems only get the page, which lists every build.
                if (platform) startDownload(platform)
              }}
              className="inline-flex h-8 items-center whitespace-nowrap rounded-lg bg-terracotta px-3 text-sm font-medium leading-5 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_1px_2px_rgb(179_60_0/0.3)] transition-colors duration-200 hover:bg-terracotta-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/80"
            >
              Download
            </Link>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

function FeatureItem({ item }: { item: LandingDropdownItem }) {
  const className = cn(
    'flex items-start gap-3 rounded-[10px] px-2.5 py-2 text-start transition-colors',
    item.disabled
      ? 'cursor-not-allowed opacity-50'
      : 'hover:bg-paper-deep focus-visible:bg-paper-deep focus-visible:outline-none'
  )

  const content = (
    <>
      {item.iconType === 'image' ? (
        <Mascot src={item.icon} className="size-7 shrink-0" />
      ) : (
        <item.icon className="size-7 shrink-0 text-terracotta" strokeWidth={2} aria-hidden />
      )}
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-semibold leading-5 text-ink">
          {item.label}
          {item.badge || item.disabled ? (
            <span className="rounded-full bg-ink/5 px-1.5 text-[11px] font-medium leading-4 text-muted">
              {item.badge ?? 'Soon'}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-[13px] leading-[18px] text-muted">
          {item.description}
        </span>
      </span>
    </>
  )
  const handleClick = () =>
    trackLandingEvent('landing_nav_click', analyticsTarget('dropdown', item.label))

  return item.disabled ? (
    <button type="button" className={className} aria-disabled="true" tabIndex={-1}>
      {content}
    </button>
  ) : isExternalHref(item.href) ? (
    <a href={item.href} className={className} onClick={handleClick}>
      {content}
    </a>
  ) : (
    <Link to={item.href} className={className} onClick={handleClick}>
      {content}
    </Link>
  )
}

/**
 * Features opens a full-width sheet under the bar, one column per job. The trigger
 * fills the bar's height so the pointer never leaves the hover group on its way down.
 * The sheet is positioned against the bar, so nothing between them may be positioned.
 * focus-within keeps it reachable by keyboard, not just hover.
 */
function FeaturesMenu() {
  return (
    <div className="nav-features group flex h-full items-center">
      <button
        type="button"
        aria-haspopup="true"
        className={cn(
          NAV_TEXT,
          'inline-flex items-center gap-1 text-(--nav-body) group-hover:text-(--nav-ink) group-focus-within:text-(--nav-ink)'
        )}
      >
        Features
        <ChevronDown
          className="size-3.5 transition-transform duration-200 group-hover:rotate-180 group-focus-within:rotate-180"
          aria-hidden
        />
      </button>
      <div className="invisible absolute inset-x-0 top-full -translate-y-1 opacity-0 transition-[opacity,transform,visibility] duration-200 [transition-timing-function:var(--ease-out-expo)] group-hover:visible group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-[visibility]">
        <div className="border-y border-ink/[0.06] bg-paper shadow-[0_40px_48px_-36px_rgb(20_18_16/0.25)]">
          <div className="mx-auto grid max-w-[83rem] grid-cols-4 gap-5 px-6 pt-6 pb-7">
            {FEATURE_COLUMNS.map((column) => (
              <div key={column.group} className="flex flex-col gap-1.5">
                <span className="px-2.5 pb-1.5 text-[11px] font-medium uppercase leading-4 tracking-[0.08em] text-muted">
                  {column.group}
                </span>
                {column.items.map((item) => (
                  <FeatureItem key={item.label} item={item} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function MobileDropdownSection({
  sectionKey,
  label,
  items,
  expanded,
  onToggle,
  onNavigate
}: {
  sectionKey: MobileDropdownKey
  label: string
  items: readonly LandingDropdownItem[]
  expanded: boolean
  onToggle: () => void
  onNavigate: () => void
}) {
  const panelId = `mobile-nav-${sectionKey}`

  return (
    <div className="overflow-hidden rounded-xl">
      <button
        type="button"
        className="flex h-9 w-full items-center justify-between gap-3 px-2 text-start text-base font-medium text-ink transition-colors hover:text-terracotta active:text-terracotta"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span>{label}</span>
        <ChevronDown
          className={cn('h-4 w-4 transition-transform', expanded ? 'rotate-180' : null)}
          aria-hidden
        />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="grid gap-0.5 pb-1 ps-3">
              {items.map((item) => {
                const content = (
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium leading-tight text-ink">
                      <span className="truncate">{item.label}</span>
                      {item.badge || item.disabled ? (
                        <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-muted">
                          {item.badge ?? 'Soon'}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-xs leading-snug text-muted">
                      {item.description}
                    </span>
                  </span>
                )
                const className = cn(
                  'flex min-h-8 items-center rounded-lg px-2 py-1 text-start transition-colors active:text-terracotta',
                  item.disabled
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:text-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/35'
                )
                const handleClick = () => {
                  trackLandingEvent(
                    'landing_nav_click',
                    analyticsTarget('mobile-dropdown', item.label)
                  )
                  onNavigate()
                }

                return item.disabled ? (
                  <button
                    key={item.label}
                    type="button"
                    className={className}
                    aria-disabled="true"
                    tabIndex={-1}
                  >
                    {content}
                  </button>
                ) : isExternalHref(item.href) ? (
                  <a key={item.label} href={item.href} className={className} onClick={handleClick}>
                    {content}
                  </a>
                ) : (
                  <Link key={item.label} to={item.href} className={className} onClick={handleClick}>
                    {content}
                  </Link>
                )
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

function MobileNavLink({
  href,
  label,
  onNavigate
}: {
  href: string
  label: string
  onNavigate: () => void
}) {
  const className =
    'flex h-9 items-center rounded-lg px-2 text-base font-medium text-ink transition-colors hover:text-terracotta active:text-terracotta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/35'

  return isExternalHref(href) ? (
    <a
      href={href}
      onClick={() => {
        trackLandingEvent('landing_external_click', analyticsTarget('mobile-nav', label))
        onNavigate()
      }}
      className={className}
    >
      {label}
    </a>
  ) : (
    <Link
      to={href}
      onClick={() => {
        trackLandingEvent('landing_nav_click', analyticsTarget('mobile-nav', label))
        onNavigate()
      }}
      className={className}
    >
      {label}
    </Link>
  )
}

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [mobileExpandedSection, setMobileExpandedSection] = useState<MobileDropdownKey | null>(null)
  const location = useLocation()
  const navigate = useNavigate()
  const { isSignedIn } = useAuth()
  const { scrolled, heroCtaInView, overDark } = usePageContext(location.pathname)
  // Signed out → /login (sign in or sign up); signed in → billing.
  const accountHref = isSignedIn ? '/account/billing' : '/login'
  const accountLabel = isSignedIn ? 'Account' : 'Sign in'
  const accountTarget = isSignedIn ? 'nav:account' : 'nav:sign-in'

  const closeMobileMenu = () => {
    setMobileMenuOpen(false)
    setMobileExpandedSection(null)
  }

  const toggleMobileMenu = () => {
    if (mobileMenuOpen) {
      setMobileExpandedSection(null)
    }
    setMobileMenuOpen(!mobileMenuOpen)
  }

  const handleLogoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    trackLandingEvent('landing_nav_click', 'nav:logo')

    if (location.pathname !== '/') {
      closeMobileMenu()
      return
    }

    e.preventDefault()
    if (location.hash) {
      void navigate('/')
    }
    scrollToLandingTarget('top', { offset: 0 })
    closeMobileMenu()
  }

  return (
    <header data-ink={overDark ? 'dark' : 'light'} className="site-nav fixed inset-x-0 top-0 z-50">
      {/* Full-width bar: transparent at the top of the page, frosted with a hairline once
          content scrolls under it, 64 → 56px. Links and actions never move sideways. */}
      <nav
        className={cn(
          'relative h-16 transition-[height] duration-[240ms] [transition-timing-function:var(--ease-out-expo)] motion-reduce:transition-none',
          scrolled && 'h-14 motion-reduce:h-16'
        )}
      >
        {/* The surface lives on a decor layer so it can fade as one opacity tween, and so
            the bar's own subtree is not a backdrop root. Colours come from --nav-* in
            index.css, which flip over dark sections. */}
        <div
          aria-hidden
          className={cn(
            'nav-surface absolute inset-0 -z-10 border-b border-(--nav-hairline) bg-(--nav-surface) opacity-0 backdrop-blur-[16px] backdrop-saturate-150 transition-[opacity,background-color,border-color] duration-200 [transition-timing-function:var(--ease-out-expo)] motion-reduce:transition-none',
            (scrolled || mobileMenuOpen) && 'opacity-100'
          )}
        />
        <div className="mx-auto flex h-full w-full max-w-[83rem] items-center justify-between gap-6 px-6">
          <div className="flex h-full items-center gap-10">
            <Link
              to="/"
              className="group flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
              onClick={handleLogoClick}
            >
              <img src="/favicon.svg" alt="" className="h-[18px] w-[22px]" />
              <span className="font-geist text-base font-semibold leading-5 tracking-[-0.03em] text-(--nav-ink) transition-colors duration-200">
                memrynote
              </span>
              <span className="rounded-full border border-(--nav-rule) px-1.5 text-[11px] font-medium leading-4 text-(--nav-body) transition-colors duration-200">
                Beta
              </span>
            </Link>

            <div className="hidden h-full items-center gap-7 lg:flex">
              <FeaturesMenu />
              {DESKTOP_NAV_LINKS.map((link) => (
                <NavLink key={link.label} href={link.href} label={link.label} />
              ))}
            </div>
          </div>

          <div className="flex items-center">
            <div className="flex items-center gap-5">
              <GitHubLink />
              <DiscordLink />
              <span aria-hidden className="hidden h-4 w-px bg-(--nav-rule) md:block" />
              <Link
                to={accountHref}
                onClick={() => trackLandingEvent('landing_nav_click', accountTarget)}
                className={cn(
                  NAV_TEXT,
                  'hidden text-(--nav-ink) hover:text-terracotta md:inline-flex'
                )}
              >
                {accountLabel}
              </Link>
              <button
                type="button"
                className="flex size-[34px] items-center justify-center rounded-[9px] border border-(--nav-rule) text-(--nav-ink) transition-[color,transform] duration-200 hover:text-terracotta active:scale-95 active:duration-75 motion-reduce:active:scale-100 md:hidden"
                onClick={toggleMobileMenu}
                aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              >
                {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            </div>
            <PrimaryAction visible={!heroCtaInView} />
          </div>
        </div>
      </nav>

      <AnimatePresence>
        {mobileMenuOpen && (
          /* This wrapper carries transform only. Any filter or opacity here — including a
             resting filter: blur(0px), which is not `none` — makes it the backdrop root for
             its subtree and turns the panel's backdrop blur into a no-op. */
          <motion.div
            initial={{ y: -8, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: -8, scale: 0.98 }}
            transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
            className="relative z-10 origin-top px-3 pt-3 md:hidden sm:px-6"
          >
            <Container size="full">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: EASE_OUT_EXPO }}
                className="material-chrome mx-auto flex max-h-[calc(100dvh-88px)] max-w-5xl flex-col gap-1.5 overflow-y-auto rounded-[20px] border border-white/70 p-2.5 shadow-[var(--shadow-float)]"
              >
                {MOBILE_DROPDOWN_SECTIONS.map((section) => (
                  <MobileDropdownSection
                    key={section.key}
                    sectionKey={section.key}
                    label={section.label}
                    items={section.items}
                    expanded={mobileExpandedSection === section.key}
                    onToggle={() => {
                      trackLandingEvent(
                        'landing_nav_click',
                        analyticsTarget('mobile-nav', section.label)
                      )
                      setMobileExpandedSection((current) =>
                        current === section.key ? null : section.key
                      )
                    }}
                    onNavigate={closeMobileMenu}
                  />
                ))}
                {DIRECT_NAV_LINKS.map((link) => (
                  <MobileNavLink
                    key={link.href}
                    href={link.href}
                    label={link.label}
                    onNavigate={closeMobileMenu}
                  />
                ))}
                <MobileNavLink
                  href={accountHref}
                  label={accountLabel}
                  onNavigate={closeMobileMenu}
                />
              </motion.div>
            </Container>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}
