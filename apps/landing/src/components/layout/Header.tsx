import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { Menu, X, ArrowUpRight, ChevronDown, type LucideIcon } from 'lucide-react'
import { HugeiconsIcon } from '@hugeicons/react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Container } from './Container'
import {
  DIRECT_NAV_LINKS,
  DOWNLOAD_NAV_ITEMS,
  FEATURE_NAV_ITEMS,
  GITHUB_STARS,
  GITHUB_URL,
  REDDIT_URL,
  type LandingDropdownItem
} from '@/lib/constants'
import { cn } from '@/lib/utils'

function useScrollToSection() {
  const navigate = useNavigate()
  const location = useLocation()

  return (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault()
    const id = href.replace('#', '')
    const element = document.getElementById(id)

    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' })
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

function NavLink({ href, label }: { href: string; label: string }) {
  const className =
    'rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-white hover:text-ink'

  return isExternalHref(href) ? (
    <a href={href} className={className}>
      {label}
    </a>
  ) : (
    <Link to={href} className={className}>
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
        'github-star-widget inline-flex items-center rounded-lg border border-border/70 bg-white/65 font-semibold text-ink shadow-[0_1px_0_rgba(255,255,255,0.7)] transition-colors hover:border-ink/15 hover:bg-white',
        compact ? 'gap-2 px-3 py-2 text-sm' : 'h-9 gap-2 px-3 text-sm'
      )}
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      onClick={onClick}
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
      className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors group-hover:bg-white group-hover:text-ink"
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

function DropdownItem({ item }: { item: LandingDropdownItem }) {
  const className = cn(
    'flex min-h-[68px] items-start gap-4 rounded-2xl px-4 py-3 text-start transition-colors',
    item.disabled
      ? 'cursor-not-allowed opacity-50'
      : 'hover:bg-paper-alt focus-visible:bg-paper-alt focus-visible:outline-none'
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

  return item.disabled ? (
    <button type="button" className={className} aria-disabled="true" tabIndex={-1}>
      {content}
    </button>
  ) : isExternalHref(item.href) ? (
    <a href={item.href} className={className}>
      {content}
    </a>
  ) : (
    <Link to={item.href} className={className}>
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
  return (
    <div className="group relative">
      <DropdownTrigger label={label} icon={icon} />
      <div className="invisible absolute left-1/2 top-full z-50 mt-3 -translate-x-1/2 opacity-0 transition-all duration-150 group-hover:visible group-hover:opacity-100">
        <div
          className={cn(
            'rounded-[22px] border border-white/70 bg-paper/95 p-3 shadow-[0_26px_80px_-28px_rgba(31,41,55,0.28),inset_0_1px_0_rgba(255,255,255,0.7)] backdrop-blur-xl',
            columns === 2 ? 'w-[574px]' : 'w-[320px]'
          )}
        >
          <div className={cn('grid gap-2', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
            {items.map((item) => (
              <DropdownItem key={item.label} item={item} />
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
  return (
    <div className="rounded-2xl border border-border/60 bg-white/65 p-3">
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
            <a key={item.label} href={item.href} className={className} onClick={onNavigate}>
              {content}
            </a>
          ) : (
            <Link key={item.label} to={item.href} className={className} onClick={onNavigate}>
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
  const scrollToSection = useScrollToSection()

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-6">
      <Container size="full">
        <nav className="mx-auto flex max-w-6xl items-center justify-between rounded-[28px] border border-white/70 bg-paper/60 px-4 py-2 shadow-[0_4px_30px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-2xl backdrop-saturate-150 sm:px-5">
          <Link to="/" className="flex items-center gap-1.5 group">
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

          <div className="hidden lg:flex items-center gap-2 rounded-full border border-border/70 bg-white/55 p-1.5">
            <DesktopDropdown label="Features" items={FEATURE_NAV_ITEMS} />
            <DesktopDropdown label="Download" items={DOWNLOAD_NAV_ITEMS} columns={1} />
            {DIRECT_NAV_LINKS.map((link) => (
              <NavLink key={link.label} href={link.href} label={link.label} />
            ))}
          </div>

          <div className="hidden md:flex items-center gap-3">
            <a
              href={REDDIT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-white/55 text-muted transition-colors hover:text-ink"
              aria-label="Join r/MemryNote"
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M20 9.7a2.2 2.2 0 0 0-3.7-1.6A10.7 10.7 0 0 0 10.4 6l1-4.7 3.3.7a1.6 1.6 0 1 0 .2-.8l-3.6-.8a.4.4 0 0 0-.5.3l-1.1 5.2A10.8 10.8 0 0 0 3.7 8a2.2 2.2 0 0 0-3.6 2.5 4.3 4.3 0 0 0 0 .7c0 3.6 4.2 6.5 9.4 6.5s9.3-2.9 9.3-6.5a3 3 0 0 0 0-.7 2.2 2.2 0 0 0 1.2-1.8zM5.5 11.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8zm8.1 4.7a5.9 5.9 0 0 1-3.6 1 5.9 5.9 0 0 1-3.6-1 .4.4 0 0 1 .5-.6 5.2 5.2 0 0 0 3.1.8 5.2 5.2 0 0 0 3.1-.8.4.4 0 0 1 .5.6zm-.3-1.9a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8z" />
              </svg>
            </a>
            <GitHubStarWidget />
            <Button variant="default" size="sm" className="rounded-full px-6" asChild>
              <a href="#waitlist" onClick={(e) => scrollToSection(e, '#waitlist')}>
                Join waitlist
                <ArrowUpRight className="w-4 h-4" />
              </a>
            </Button>
          </div>

          <button
            type="button"
            className="md:hidden rounded-full border border-border/70 bg-white/60 p-3 text-ink transition-colors hover:text-terracotta"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </nav>
      </Container>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="md:hidden px-3 pt-3 sm:px-6"
          >
            <Container size="full">
              <div className="mx-auto flex max-w-6xl flex-col gap-4 rounded-[28px] border border-white/70 bg-paper/90 p-5 shadow-[var(--shadow-float)] backdrop-blur-xl">
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
                      onClick={() => setMobileMenuOpen(false)}
                      className="rounded-2xl border border-border/60 bg-white/65 px-4 py-3 text-xl font-serif font-medium text-ink transition-colors hover:text-terracotta"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      key={link.href}
                      to={link.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className="rounded-2xl border border-border/60 bg-white/65 px-4 py-3 text-xl font-serif font-medium text-ink transition-colors hover:text-terracotta"
                    >
                      {link.label}
                    </Link>
                  )
                )}
                <a
                  href={REDDIT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between rounded-2xl border border-border/60 bg-white/65 px-4 py-3 text-lg font-medium text-muted transition-colors hover:text-ink"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <span className="flex items-center gap-2">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm6.066 13.71c.147.422.22.864.22 1.317 0 2.78-3.2 5.027-7.153 5.027S4 17.807 4 15.027c0-.453.073-.895.22-1.317a1.607 1.607 0 0 1-.634-1.283 1.625 1.625 0 0 1 2.768-1.152 8.07 8.07 0 0 1 4.358-1.378l.82-3.862a.342.342 0 0 1 .406-.265l2.73.577a1.14 1.14 0 1 1-.13.614l-2.44-.516-.738 3.47a8.026 8.026 0 0 1 4.296 1.368 1.625 1.625 0 0 1 2.768 1.152c0 .503-.228.953-.586 1.252h.018zM9.066 14.5c-.9 0-1.627.727-1.627 1.624s.727 1.625 1.627 1.625c.9 0 1.627-.728 1.627-1.625 0-.897-.727-1.625-1.627-1.625zm5.868 0c-.9 0-1.627.727-1.627 1.624s.727 1.625 1.627 1.625c.9 0 1.627-.728 1.627-1.625 0-.897-.728-1.625-1.627-1.625zm-4.797 4.337a.19.19 0 0 1 .265-.027c.774.594 1.853.867 2.864.773a3.705 3.705 0 0 0 2.864-.773.19.19 0 0 1 .238.293c-.9.74-2.088 1.09-3.102 1.09-1.015 0-2.202-.35-3.102-1.09a.19.19 0 0 1-.027-.266z" />
                    </svg>
                    Reddit
                  </span>
                  <ArrowUpRight className="w-4 h-4" />
                </a>
                <GitHubStarWidget compact onClick={() => setMobileMenuOpen(false)} />
                <Button variant="default" className="mt-2 w-full rounded-full" asChild>
                  <a
                    href="#waitlist"
                    onClick={(e) => {
                      scrollToSection(e, '#waitlist')
                      setMobileMenuOpen(false)
                    }}
                  >
                    Join Waitlist
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
