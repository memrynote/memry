import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Menu, X, Github, MessageCircle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Container } from './Container'
import { NAV_LINKS, GITHUB_URL, DISCORD_URL } from '@/lib/constants'

const scrollToSection = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
  e.preventDefault()
  const id = href.replace('#', '')
  const element = document.getElementById(id)
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-paper/80 backdrop-blur-md border-b border-border/50">
      <Container>
        <nav className="flex items-center justify-between h-20">
          <Link to="/" className="flex items-center gap-2 group">
            <span className="font-serif text-3xl font-medium text-ink tracking-tight group-hover:text-terracotta transition-colors">
              Memry.
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-8">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={(e) => scrollToSection(e, link.href)}
                className="text-sm font-medium transition-all relative py-1 text-muted hover:text-ink group"
              >
                {link.label}
                <span className="absolute bottom-0 left-0 w-0 h-px bg-terracotta transition-all duration-300 group-hover:w-full" />
              </a>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-3">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 text-muted hover:text-ink transition-colors"
              aria-label="View on GitHub"
            >
              <Github className="w-5 h-5" />
            </a>
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 text-muted hover:text-ink transition-colors"
              aria-label="Join Discord"
            >
              <MessageCircle className="w-5 h-5" />
            </a>
            <Button
              variant="default"
              size="sm"
              className="font-sans font-medium rounded-full px-6"
              asChild
            >
              <a href="#waitlist">Join Waitlist</a>
            </Button>
          </div>

          <button
            type="button"
            className="md:hidden p-2 text-ink hover:text-terracotta transition-colors"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </nav>
      </Container>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden border-t border-border bg-paper overflow-hidden"
          >
            <Container className="py-6">
              <div className="flex flex-col gap-4">
                {NAV_LINKS.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={(e) => {
                      scrollToSection(e, link.href)
                      setMobileMenuOpen(false)
                    }}
                    className="text-xl font-serif font-medium py-2 transition-colors border-b border-border/50 text-ink hover:text-terracotta"
                  >
                    {link.label}
                  </a>
                ))}
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-lg font-medium py-2 text-muted hover:text-ink transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <Github className="w-5 h-5" />
                  GitHub
                </a>
                <a
                  href={DISCORD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-lg font-medium py-2 text-muted hover:text-ink transition-colors"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <MessageCircle className="w-5 h-5" />
                  Discord
                </a>
                <Button variant="default" className="mt-4 w-full rounded-full" asChild>
                  <a href="#waitlist" onClick={() => setMobileMenuOpen(false)}>
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
