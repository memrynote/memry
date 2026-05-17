import { useEffect, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { Menu, X, ArrowUpRight, ChevronDown, type LucideIcon } from 'lucide-react'
import { HugeiconsIcon } from '@hugeicons/react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Container } from './Container'
import { ThemeToggle } from './ThemeToggle'
import {
  DIRECT_NAV_LINKS,
  DOWNLOAD_NAV_ITEMS,
  FEATURE_NAV_ITEMS,
  GITHUB_STARS,
  GITHUB_URL,
  type LandingDropdownItem
} from '@/lib/constants'
import { cn } from '@/lib/utils'
import { scrollToLandingTarget } from '@/lib/smooth-scroll'
import { trackLandingEvent, type LandingEventName } from '@/lib/analytics'

function useScrollToSection() {
  const navigate = useNavigate()
  const location = useLocation()

  return (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault()
    const id = href.replace('#', '')
    const element = document.getElementById(id)

    if (element) {
      scrollToLandingTarget(element)
    } else if (location.pathname !== '/') {
      navigate('/' + href)
    }
  }
}

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
  onClick
}: {
  compact?: boolean
  onClick?: () => void
}) {
  const formattedStars = formatStarCount(GITHUB_STARS)

  return (
    <a
      className={cn(
        'github-star-widget inline-flex items-center rounded-lg border border-border/70 bg-card/65 font-semibold text-ink shadow-[0_1px_0_rgba(255,255,255,0.7)] transition-colors hover:border-ink/15 hover:bg-card dark:border-white/10 dark:shadow-none',
        compact ? 'gap-2 px-3 py-2 text-sm' : 'h-9 gap-2 px-3 text-sm'
      )}
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      onClick={() => {
        trackLandingEvent('landing_external_click', 'external:github')
        onClick?.()
      }}
      aria-label={`${formattedStars} GitHub stars`}
    >
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          fillRule="evenodd"
          clipRule="evenodd"
          d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18A11 11 0 0 1 12 5.53c.98 0 1.97.13 2.89.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.18c0 .31.21.67.79.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"
        />
      </svg>
      <span>Star</span>
      <strong className="border-s border-border/80 ps-2 font-mono-accent text-[13px] font-semibold">
        {formattedStars}
      </strong>
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
        className="h-3.5 w-3.5 transition-transform group-hover:rotate-180"
        aria-hidden
      />
    </button>
  )
}

function DropdownIcon({ item, className }: { item: LandingDropdownItem; className: string }) {
  if (item.iconType === 'hugeicon') {
    return <HugeiconsIcon icon={item.icon} className={className} strokeWidth={2.4} aria-hidden />
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
      : 'hover:bg-paper-alt focus-visible:bg-paper-alt focus-visible:outline-none dark:hover:bg-paper-deep dark:focus-visible:bg-paper-deep'
  )

  const content = (
    <>
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-terracotta/10 text-terracotta">
        <DropdownIcon item={item} className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-base font-medium leading-tight text-ink">
          {item.label}
          {item.disabled ? (
            <span className="rounded-full bg-ink/5 px-1.5 py-0.5 font-mono-accent text-[8px] uppercase tracking-[0.16em] text-muted">
              Soon
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
      <div className="invisible absolute left-1/2 top-full z-50 mt-3 -translate-x-1/2 opacity-0 transition-all duration-150 group-hover:visible group-hover:opacity-100">
        <div
          className={cn(
            'rounded-[22px] border border-white/70 bg-paper/95 p-3 shadow-[0_26px_80px_-28px_rgba(31,41,55,0.28),inset_0_1px_0_rgba(255,255,255,0.7)] backdrop-blur-xl dark:border-white/10 dark:bg-paper/90 dark:shadow-[0_26px_80px_-28px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.04)]',
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
  title,
  items,
  onNavigate
}: {
  title: string
  items: readonly LandingDropdownItem[]
  onNavigate: () => void
}) {
  const eventName = dropdownEvent(title)

  return (
    <div className="rounded-2xl border border-border/60 bg-card/65 p-3">
      <p className="px-2 pb-2 font-mono-accent text-[10px] uppercase tracking-[0.18em] text-muted">
        {title}
      </p>
      <div className="grid gap-2">
        {items.map((item) => {
          const content = (
            <>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-paper-alt text-ink">
                <DropdownIcon item={item} className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-base font-medium text-ink">
                  {item.label}
                  {item.disabled ? (
                    <span className="rounded-full bg-ink/5 px-2 py-0.5 font-mono-accent text-[8px] uppercase tracking-[0.14em] text-muted">
                      Coming soon
                    </span>
                  ) : null}
                </span>
                <span className="mt-1 block text-sm leading-snug text-muted">
                  {item.description}
                </span>
              </span>
            </>
          )
          const className = cn(
            'flex items-center gap-3 rounded-xl px-2 py-2 text-start transition-colors',
            item.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-paper-alt'
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
    </div>
  )
}

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [headerScrolled, setHeaderScrolled] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const scrollToSection = useScrollToSection()
  const showHeaderSurface = headerScrolled || mobileMenuOpen

  useEffect(() => {
    const updateHeaderSurface = () => {
      setHeaderScrolled(window.scrollY > 12)
    }

    updateHeaderSurface()
    window.addEventListener('scroll', updateHeaderSurface, { passive: true })

    return () => window.removeEventListener('scroll', updateHeaderSurface)
  }, [])

  const handleLogoClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    trackLandingEvent('landing_nav_click', 'nav:logo')

    if (location.pathname !== '/') {
      setMobileMenuOpen(false)
      return
    }

    e.preventDefault()
    if (location.hash) {
      navigate('/')
    }
    scrollToLandingTarget('top', { offset: 0 })
    setMobileMenuOpen(false)
  }

  return (
    <header
      className={cn(
        'fixed inset-x-0 top-0 z-50 px-3 pt-4 transition-all duration-300 before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-0 before:h-24 before:bg-gradient-to-b before:from-paper/92 before:via-paper/62 before:to-paper/0 before:transition-opacity before:duration-300 dark:before:from-paper/92 dark:before:via-paper/62 dark:before:to-paper/0 sm:px-6',
        showHeaderSurface ? 'before:opacity-100' : 'before:opacity-0'
      )}
    >
      <Container size="full" className="relative z-10">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-1 py-2 sm:px-0">
          <Link to="/" className="flex items-center gap-1.5 group" onClick={handleLogoClick}>
            <span className="flex h-7 w-7 items-center justify-center">
              <img src="/favicon.svg" alt="" className="w-5 h-5" />
            </span>
            <div className="leading-none">
              <span className="flex items-center gap-2">
                <span className="block font-geist text-2xl font-medium tracking-tight text-ink transition-colors group-hover:text-terracotta">
                  memry
                </span>
                <span className="rounded-full bg-terracotta/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-terracotta">
                  Preview
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

          <div className="hidden md:flex items-center gap-3">
            <ThemeToggle />
            <GitHubStarWidget />
            <Button variant="default" size="sm" className="rounded-full px-6" asChild>
              <a
                href="#waitlist"
                onClick={(e) => {
                  trackLandingEvent('landing_nav_click', 'nav:join')
                  scrollToSection(e, '#waitlist')
                }}
              >
                Join
                <ArrowUpRight className="w-4 h-4" />
              </a>
            </Button>
          </div>

          <div className="md:hidden flex items-center gap-2">
            <ThemeToggle />
            <button
              type="button"
              className="rounded-full border border-border/70 bg-card/60 p-3 text-ink transition-colors hover:text-terracotta"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </nav>
      </Container>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="relative z-10 px-3 pt-3 md:hidden sm:px-6"
          >
            <Container size="full">
              <div className="mx-auto flex max-w-6xl flex-col gap-4 rounded-[28px] border border-white/70 bg-paper/90 p-5 shadow-[var(--shadow-float)] backdrop-blur-xl dark:border-white/10">
                <MobileDropdownSection
                  title="Features"
                  items={FEATURE_NAV_ITEMS}
                  onNavigate={() => setMobileMenuOpen(false)}
                />
                <MobileDropdownSection
                  title="Download"
                  items={DOWNLOAD_NAV_ITEMS}
                  onNavigate={() => setMobileMenuOpen(false)}
                />
                {DIRECT_NAV_LINKS.map((link) =>
                  isExternalHref(link.href) ? (
                    <a
                      key={link.href}
                      href={link.href}
                      onClick={() => {
                        trackLandingEvent(
                          'landing_external_click',
                          analyticsTarget('mobile-nav', link.label)
                        )
                        setMobileMenuOpen(false)
                      }}
                      className="rounded-2xl border border-border/60 bg-card/65 px-4 py-3 text-xl font-serif font-medium text-ink transition-colors hover:text-terracotta"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      key={link.href}
                      to={link.href}
                      onClick={() => {
                        trackLandingEvent(
                          'landing_nav_click',
                          analyticsTarget('mobile-nav', link.label)
                        )
                        setMobileMenuOpen(false)
                      }}
                      className="rounded-2xl border border-border/60 bg-card/65 px-4 py-3 text-xl font-serif font-medium text-ink transition-colors hover:text-terracotta"
                    >
                      {link.label}
                    </Link>
                  )
                )}
                <GitHubStarWidget compact onClick={() => setMobileMenuOpen(false)} />
                <ThemeToggle variant="inline" />
                <Button variant="default" className="mt-2 w-full rounded-full" asChild>
                  <a
                    href="#waitlist"
                    onClick={(e) => {
                      trackLandingEvent('landing_nav_click', 'mobile-nav:join')
                      scrollToSection(e, '#waitlist')
                      setMobileMenuOpen(false)
                    }}
                  >
                    Join
                  </a>
                </Button>
              </div>
            </Container>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}
