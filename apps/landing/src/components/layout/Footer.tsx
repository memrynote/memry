import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Container } from './Container'
import { FOOTER_LINKS, TWITTER_DEV_URL } from '@/lib/constants'
import { trackLandingEvent } from '@/lib/analytics'

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
  const className = 'text-sm text-muted hover:text-terracotta transition-colors font-medium'

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
    <footer className="border-t border-border bg-paper py-20">
      <Container>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-10 mb-16">
          <div className="col-span-2 md:col-span-2 pe-8">
            <Link
              to="/"
              className="inline-flex items-center gap-2 mb-6 group"
              onClick={() => trackLandingEvent('landing_nav_click', 'footer:logo')}
            >
              <img src="/favicon.svg" alt="" className="h-7 w-7" />
              <span className="font-serif text-3xl font-medium text-ink group-hover:text-terracotta transition-colors">
                memrynote
              </span>
            </Link>
            <p className="text-lg text-muted font-sans leading-relaxed max-w-sm">
              Notes, tasks, and journal — finally in one place. Private, fast, and yours forever.
            </p>
          </div>

          <div>
            <h4 className="font-serif text-lg text-ink mb-6">Product</h4>
            <ul className="space-y-4">
              {FOOTER_LINKS.product.map((link) => (
                <li key={link.label}>
                  <Link
                    to={footerHref(link.href, pathname)}
                    className="text-sm text-muted hover:text-terracotta transition-colors font-medium"
                    onClick={() => trackLandingEvent('landing_nav_click', footerTarget(link.label))}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-serif text-lg text-ink mb-6">Compare</h4>
            <ul className="space-y-4">
              {FOOTER_LINKS.compare.map((link) => (
                <li key={link.label}>
                  <Link
                    to={footerHref(link.href, pathname)}
                    className="text-sm text-muted hover:text-terracotta transition-colors font-medium"
                    onClick={() => trackLandingEvent('landing_nav_click', footerTarget(link.label))}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-serif text-lg text-ink mb-6">Resources</h4>
            <ul className="space-y-4">
              {FOOTER_LINKS.resources.map((link) => (
                <li key={link.label}>
                  <FooterLink href={link.href}>{link.label}</FooterLink>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-serif text-lg text-ink mb-6">Connect</h4>
            <ul className="space-y-4">
              {FOOTER_LINKS.social.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-muted hover:text-terracotta transition-colors font-medium"
                    onClick={() =>
                      trackLandingEvent('landing_external_click', footerTarget(link.label))
                    }
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-border flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-sm text-muted/60 font-mono-accent">
            © {currentYear} memrynote. All rights reserved.
          </p>
          <p className="text-sm text-muted/60 font-mono-accent">
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
    </footer>
  )
}
