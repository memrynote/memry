import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { Container } from './Container'
import { AskAi } from '@/components/site/AskAi'
import { FOOTER_LINKS, TWITTER_DEV_URL } from '@/lib/constants'
import { trackLandingEvent } from '@/lib/analytics'

const FOOTER_COLUMNS = [
  { title: 'Product', links: FOOTER_LINKS.product },
  { title: 'Compare', links: FOOTER_LINKS.compare },
  { title: 'Resources', links: FOOTER_LINKS.resources },
  { title: 'Connect', links: FOOTER_LINKS.social }
] as const

const TRUST_LINE = ['End-to-end encrypted', 'Open source', 'Local-first'] as const

function footerHref(href: string, pathname: string): string {
  if (href.startsWith('#') && pathname !== '/') return '/' + href
  return href
}

function footerTarget(label: ReactNode) {
  return `footer:${String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')}`
}

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  const className = 'text-sm font-medium text-dark-muted transition-colors hover:text-terracotta'

  if (href.startsWith('http')) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={() => trackLandingEvent('landing_external_click', footerTarget(children))}
      >
        {children}
      </a>
    )
  }

  return (
    <Link
      to={href}
      className={className}
      onClick={() => trackLandingEvent('landing_nav_click', footerTarget(children))}
    >
      {children}
    </Link>
  )
}

export function Footer() {
  const currentYear = new Date().getFullYear()
  const { pathname } = useLocation()

  return (
    <footer className="page-rails zone-dark overflow-hidden border-t border-white/10 py-20 md:py-24">
      <Container>
        <div className="mb-16 grid grid-cols-2 gap-x-8 gap-y-12 md:grid-cols-6 md:gap-10">
          <div className="col-span-2 pe-8">
            <Link
              to="/"
              className="group inline-flex items-center gap-2"
              onClick={() => trackLandingEvent('landing_nav_click', 'footer:logo')}
            >
              <img src="/favicon.svg" alt="" className="h-6 w-6" />
              <span className="font-geist text-2xl font-medium tracking-tight text-ink-inverted transition-colors group-hover:text-terracotta">
                memrynote
              </span>
            </Link>
            <p className="mt-5 max-w-sm text-base leading-relaxed text-dark-muted">
              Notes, tasks, and journal, finally in one place. Private, fast, and yours forever.
            </p>
            <div className="mt-7">
              <AskAi />
            </div>
            <p className="mt-7 font-mono-accent text-[10px] uppercase tracking-[0.18em] text-dark-muted/70">
              {TRUST_LINE.map((fact, i) => (
                <span key={fact} className="inline-block">
                  {fact}
                  {i < TRUST_LINE.length - 1 && (
                    <span aria-hidden className="mx-2.5 text-terracotta/60">
                      ·
                    </span>
                  )}
                </span>
              ))}
            </p>
          </div>

          {FOOTER_COLUMNS.map((column) => (
            <div key={column.title}>
              <h4 className="mb-5 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-ink-inverted/60">
                {column.title}
              </h4>
              <ul className="space-y-3.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <FooterLink href={footerHref(link.href, pathname)}>{link.label}</FooterLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-8 md:flex-row">
          <p className="font-mono-accent text-xs text-dark-muted/80">
            © {currentYear} memrynote. All rights reserved.
          </p>
          <p className="font-mono-accent text-xs text-dark-muted/80">
            An indie project by{' '}
            <a
              href={TWITTER_DEV_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-terracotta hover:underline"
              onClick={() => trackLandingEvent('landing_external_click', 'footer:founder-twitter')}
            >
              @h4yfans
            </a>
          </p>
        </div>
      </Container>

      {/* The wordmark, flush to the footer's bottom edge; the negative margin cancels the
          footer's own bottom padding. It is sized to land exactly between the page grid's
          rails: "memrynote" in DM Sans 500 runs 5.3x its font size wide, so 240px fills the
          1280px rail box and 18.4vw fills a viewport-wide one — a hair under 100/5.3 so the
          scrollbar, which vw counts and the rails do not, still has room. The old
          16vw/260px clamp spilled past the rails once the viewport passed ~1537px. */}
      <p
        aria-hidden
        className="pointer-events-none -mb-20 mt-12 select-none text-center font-geist font-medium leading-[0.9] tracking-[-0.02em] text-ink-inverted/[0.07] [mask-image:linear-gradient(to_bottom,black_18%,transparent_86%)] [-webkit-mask-image:linear-gradient(to_bottom,black_18%,transparent_86%)] md:-mb-24"
        style={{ fontSize: 'clamp(52px, 18.4vw, 240px)' }}
      >
        memrynote
      </p>
    </footer>
  )
}
