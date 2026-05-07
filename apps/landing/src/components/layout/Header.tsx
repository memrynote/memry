import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { Menu, X, Github, ArrowUpRight } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Container } from './Container'
import { NAV_LINKS, GITHUB_URL, REDDIT_URL } from '@/lib/constants'

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

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const scrollToSection = useScrollToSection()

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-6">
      <Container size="full">
        <nav className="mx-auto flex max-w-6xl items-center justify-between rounded-[28px] border border-white/70 bg-paper/60 px-4 py-2 shadow-[0_4px_30px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-2xl backdrop-saturate-150 sm:px-5">
          <Link to="/" className="flex items-center gap-3 group">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-terracotta/20 bg-white/80 shadow-sm">
              <img src="/favicon.svg" alt="" className="w-5 h-5" />
            </span>
            <div className="leading-none">
              <span className="flex items-center gap-2">
                <span className="block font-serif text-2xl font-medium tracking-tight text-ink transition-colors group-hover:text-terracotta">
                  Memry.
                </span>
                <span className="rounded-full bg-terracotta/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-widest text-terracotta">
                  Preview
                </span>
              </span>
            </div>
          </Link>

          <div className="hidden lg:flex items-center gap-2 rounded-full border border-border/70 bg-white/55 p-1.5">
            {NAV_LINKS.map((link) =>
              link.href.startsWith('http') ? (
                <a
                  key={link.href}
                  href={link.href}
                  className="rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-white hover:text-ink"
                >
                  {link.label}
                </a>
              ) : link.href.startsWith('/') ? (
                <Link
                  key={link.href}
                  to={link.href}
                  className="rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-white hover:text-ink"
                >
                  {link.label}
                </Link>
              ) : (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={(e) => scrollToSection(e, link.href)}
                  className="rounded-full px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-white hover:text-ink"
                >
                  {link.label}
                </a>
              )
            )}
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
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-white/55 text-muted transition-colors hover:text-ink"
              aria-label="View on GitHub"
            >
              <Github className="w-5 h-5" />
            </a>
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
                {NAV_LINKS.map((link) =>
                  link.href.startsWith('http') ? (
                    <a
                      key={link.href}
                      href={link.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className="rounded-2xl border border-border/60 bg-white/65 px-4 py-3 text-xl font-serif font-medium text-ink transition-colors hover:text-terracotta"
                    >
                      {link.label}
                    </a>
                  ) : link.href.startsWith('/') ? (
                    <Link
                      key={link.href}
                      to={link.href}
                      onClick={() => setMobileMenuOpen(false)}
                      className="rounded-2xl border border-border/60 bg-white/65 px-4 py-3 text-xl font-serif font-medium text-ink transition-colors hover:text-terracotta"
                    >
                      {link.label}
                    </Link>
                  ) : (
                    <a
                      key={link.href}
                      href={link.href}
                      onClick={(e) => {
                        scrollToSection(e, link.href)
                        setMobileMenuOpen(false)
                      }}
                      className="rounded-2xl border border-border/60 bg-white/65 px-4 py-3 text-xl font-serif font-medium text-ink transition-colors hover:text-terracotta"
                    >
                      {link.label}
                    </a>
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
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between rounded-2xl border border-border/60 bg-white/65 px-4 py-3 text-lg font-medium text-muted transition-colors hover:text-ink"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <span className="flex items-center gap-2">
                    <Github className="w-5 h-5" />
                    GitHub
                  </span>
                  <ArrowUpRight className="w-4 h-4" />
                </a>
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
