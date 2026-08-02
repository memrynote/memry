import { useEffect, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router'
import { Menu, X, ChevronDown, type LucideIcon } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Mascot } from '@/components/ui/mascot'
import { Container } from './Container'
import {
  DIRECT_NAV_LINKS,
  DOWNLOAD_NAV_ITEMS,
  FEATURE_NAV_ITEMS,
  GITHUB_URL,
  type LandingDropdownItem
} from '@/lib/constants'
import { cn } from '@/lib/utils'
import { scrollToLandingTarget } from '@/lib/smooth-scroll'
import { trackLandingEvent, type LandingEventName } from '@/lib/analytics'
import { useAuth } from '@/contexts/auth-context'

function isExternalHref(href: string) {
  return href.startsWith('http')
}

function formatStarCount(count: number) {
  return new Intl.NumberFormat('en-US').format(count)
}

function analyticsTarget(scope: string, label: string) {
  return `${scope}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function dropdownEvent(label: string): LandingEventName {
  return label === 'Download' ? 'landing_download_click' : 'landing_nav_click'
}

type MobileDropdownKey = 'features' | 'download'

const MOBILE_DROPDOWN_SECTIONS: readonly {
  key: MobileDropdownKey
  label: string
  items: readonly LandingDropdownItem[]
}[] = [
  { key: 'features', label: 'Features', items: FEATURE_NAV_ITEMS },
  { key: 'download', label: 'Download', items: DOWNLOAD_NAV_ITEMS }
] as const

function NavLink({ href, label }: { href: string; label: string }) {
  const className =
    'rounded-full px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-ink'
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

function GitHubStarWidget({
  compact = false,
  iconOnly = false,
  onClick,
  className
}: {
  compact?: boolean
  iconOnly?: boolean
  onClick?: () => void
  className?: string
}) {
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
        // Keep the build-time fallback when the cached GitHub count is unavailable.
      }
    }

    void loadStars()

    return () => {
      active = false
    }
  }, [])

  return (
    <a
      className={cn(
        'github-star-widget inline-flex items-center rounded-lg border border-border/70 bg-card/65 font-semibold text-ink shadow-[0_1px_0_rgba(255,255,255,0.7)] transition-[color,background-color,border-color,transform] duration-200 hover:border-ink/15 hover:bg-card active:scale-[0.97] active:duration-75 motion-reduce:active:scale-100',
        iconOnly
          ? 'h-10 w-10 justify-center rounded-full p-0'
          : compact
            ? 'gap-2 px-3 py-2 text-sm'
            : 'h-9 gap-2 px-3 text-sm',
        className
      )}
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      onClick={() => {
        trackLandingEvent('landing_external_click', 'external:github')
        onClick?.()
      }}
      aria-label={formattedStars ? `${formattedStars} GitHub stars` : 'GitHub stars'}
    >
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18A11 11 0 0 1 12 5.53c.98 0 1.97.13 2.89.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.18c0 .31.21.67.79.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
        />
      </svg>
      {iconOnly ? null : (
        <>
          <span>Star</span>
          {formattedStars ? (
            <strong className="border-s border-border/80 ps-2 font-mono-accent text-[13px] font-semibold">
              {formattedStars}
            </strong>
          ) : null}
        </>
      )}
    </a>
  )
}

function DropdownTrigger({ label, icon: Icon }: { label: string; icon?: LucideIcon }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-muted transition-colors group-hover:text-ink"
      aria-haspopup="true"
    >
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
      {label}
      <ChevronDown
        className="h-3.5 w-3.5 transition-transform group-hover:rotate-180 group-focus-within:rotate-180"
        aria-hidden
      />
    </button>
  )
}

function DropdownIcon({ item, className }: { item: LandingDropdownItem; className: string }) {
  if (item.iconType === 'image') {
    return <Mascot src={item.icon} className={className} />
  }

  const Icon = item.icon as LucideIcon
  return <Icon className={className} strokeWidth={2.4} aria-hidden />
}

function DropdownItem({
  item,
  eventName
}: {
  item: LandingDropdownItem
  eventName: LandingEventName
}) {
  const className = cn(
    'flex min-h-[68px] items-start gap-4 rounded-2xl px-4 py-3 text-start transition-colors',
    item.disabled
      ? 'cursor-not-allowed opacity-50'
      : 'hover:bg-paper-alt focus-visible:bg-paper-alt focus-visible:outline-none'
  )

  const content = (
    <>
      <span
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
          item.iconType !== 'image' && 'bg-terracotta/10 text-terracotta'
        )}
      >
        <DropdownIcon item={item} className={item.iconType === 'image' ? 'h-8 w-8' : 'h-5 w-5'} />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-base font-medium leading-tight text-ink">
          {item.label}
          {item.badge || item.disabled ? (
            <span className="rounded-full bg-ink/5 px-1.5 py-0.5 font-mono-accent text-[8px] uppercase tracking-[0.16em] text-muted">
              {item.badge ?? 'Soon'}
            </span>
          ) : null}
        </span>
        <span className="mt-2 block text-sm leading-snug text-muted">{item.description}</span>
      </span>
    </>
  )
  const handleClick = () => trackLandingEvent(eventName, analyticsTarget('dropdown', item.label))

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

function DesktopDropdown({
  label,
  items,
  icon,
  columns = 2
}: {
  label: string
  items: readonly LandingDropdownItem[]
  icon?: LucideIcon
  columns?: 1 | 2
}) {
  const eventName = dropdownEvent(label)

  return (
    <div className="group relative">
      <DropdownTrigger label={label} icon={icon} />
      {/* Materialize from the trigger: scale+lift on this wrapper, opacity on the panel.
          The wrapper must never carry filter or opacity while animating — either would
          make it a backdrop root and suppress the panel's backdrop blur until the
          transition ends (glass "popping in" late). Transform is safe.
          focus-within keeps the menu reachable by keyboard, not just hover. */}
      <div className="invisible absolute start-0 top-full z-50 mt-3 origin-top translate-y-1 scale-[0.97] transition-[transform,visibility] duration-200 [transition-timing-function:var(--ease-out-expo)] group-hover:visible group-hover:translate-y-0 group-hover:scale-100 group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:scale-100 motion-reduce:translate-y-0 motion-reduce:scale-100 motion-reduce:transition-[visibility]">
        <div
          className={cn(
            'rounded-[22px] border border-white/60 bg-card/55 backdrop-blur-2xl backdrop-saturate-150 p-3 opacity-0 transition-opacity duration-200 [transition-timing-function:var(--ease-out-expo)] group-hover:opacity-100 group-focus-within:opacity-100 shadow-[0_26px_80px_-28px_rgba(31,41,55,0.28),inset_0_1px_0_rgba(255,255,255,0.7)]',
            columns === 2 ? 'w-[574px]' : 'w-[320px]'
          )}
        >
          <div className={cn('grid gap-2', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
            {items.map((item) => (
              <DropdownItem key={item.label} item={item} eventName={eventName} />
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
  const eventName = dropdownEvent(label)
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
                        <span className="shrink-0 font-mono-accent text-[8px] uppercase tracking-[0.12em] text-muted">
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
                  trackLandingEvent(eventName, analyticsTarget('mobile-dropdown', item.label))
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
  // ponytail: signed out → /login (sign-in/up); signed in → billing. Label stays "Account" either way.
  const accountHref = isSignedIn ? '/account/billing' : '/login'
  const accountLabel = 'Account'
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
      navigate('/')
    }
    scrollToLandingTarget('top', { offset: 0 })
    closeMobileMenu()
  }

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-6">
      <Container size="full" className="relative z-10">
        <nav className="relative mx-auto flex max-w-6xl items-center justify-between rounded-full border border-white/60 px-3 py-2 shadow-card sm:px-4">
          {/* Glass lives on a decor layer, not on <nav>: an element with backdrop-filter
              becomes the backdrop root for its subtree, which would stop the dropdown
              panels below from blurring the page behind them. */}
          <div
            aria-hidden
            className="absolute inset-0 -z-10 rounded-full bg-card/55 backdrop-blur-2xl backdrop-saturate-150"
          />
          <div className="flex items-center gap-2 lg:gap-5">
            <Link to="/" className="flex items-center gap-1.5 group" onClick={handleLogoClick}>
              <span className="flex h-7 w-7 items-center justify-center">
                <img src="/favicon.svg" alt="" className="w-5 h-5" />
              </span>
              <div className="leading-none">
                <span className="flex items-center gap-2">
                  <span className="block font-geist text-2xl font-medium tracking-tight text-ink transition-colors group-hover:text-terracotta">
                    memrynote
                  </span>
                  <span className="rounded-full bg-terracotta/10 px-1.5 py-0.5 font-mono-accent text-[8px] uppercase tracking-[0.16em] text-terracotta">
                    Beta
                  </span>
                </span>
              </div>
            </Link>

            <div className="hidden items-center gap-1.5 lg:flex">
              <DesktopDropdown label="Features" items={FEATURE_NAV_ITEMS} />
              <DesktopDropdown label="Download" items={DOWNLOAD_NAV_ITEMS} columns={1} />
              {DIRECT_NAV_LINKS.map((link) => (
                <NavLink key={link.label} href={link.href} label={link.label} />
              ))}
            </div>
          </div>

          <div className="hidden md:flex items-center gap-3">
            <GitHubStarWidget />
            <span aria-hidden className="h-5 w-px bg-border/80" />
            <Button variant="ghost" size="sm" className="rounded-full px-4" asChild>
              <Link
                to={accountHref}
                onClick={() => trackLandingEvent('landing_nav_click', accountTarget)}
              >
                {accountLabel}
              </Link>
            </Button>
          </div>

          <div className="md:hidden flex items-center gap-2">
            <GitHubStarWidget iconOnly className="h-9 w-9" />
            <button
              type="button"
              className="rounded-full border border-border/70 bg-card/60 p-3 text-ink transition-[color,transform] duration-200 hover:text-terracotta active:scale-95 active:duration-75 motion-reduce:active:scale-100"
              onClick={toggleMobileMenu}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </nav>
      </Container>

      <AnimatePresence>
        {mobileMenuOpen && (
          /* Same rule as DesktopDropdown: this wrapper carries transform only. Any filter or
             opacity here — including a resting filter: blur(0px), which is not `none` — makes it
             the backdrop root for its subtree and turns the panel's backdrop blur into a no-op. */
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
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="material-chrome mx-auto flex max-h-[calc(100dvh-88px)] max-w-6xl flex-col gap-1.5 overflow-y-auto rounded-[20px] border border-white/70 p-2.5 shadow-[var(--shadow-float)]"
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
