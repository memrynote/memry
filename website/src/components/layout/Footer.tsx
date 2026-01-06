import { Link } from 'react-router-dom'
import { Container } from './Container'
import { FOOTER_LINKS } from '@/lib/constants'

export function Footer() {
  const currentYear = new Date().getFullYear()

  return (
    <footer className="border-t border-border bg-paper py-20">
      <Container>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-10 mb-16">
          <div className="col-span-2 md:col-span-2 pr-8">
            <Link to="/" className="inline-block mb-6 group">
              <span className="font-serif text-3xl font-medium text-ink group-hover:text-terracotta transition-colors">
                Memry.
              </span>
            </Link>
            <p className="text-lg text-muted font-sans leading-relaxed max-w-sm">
              The local-first PKM that combines task management, journaling, and note-taking in one
              warm, focused space.
            </p>
          </div>

          <div>
            <h4 className="font-serif text-lg text-ink mb-6">Product</h4>
            <ul className="space-y-4">
              {FOOTER_LINKS.product.map((link) => (
                <li key={link.label}>
                  <Link
                    to={link.href}
                    className="text-sm text-muted hover:text-terracotta transition-colors font-medium"
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
                  <Link
                    to={link.href}
                    className="text-sm text-muted hover:text-terracotta transition-colors font-medium"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-serif text-lg text-ink mb-6">Legal</h4>
            <ul className="space-y-4">
              {FOOTER_LINKS.legal.map((link) => (
                <li key={link.label}>
                  <Link
                    to={link.href}
                    className="text-sm text-muted hover:text-terracotta transition-colors font-medium"
                  >
                    {link.label}
                  </Link>
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
            © {currentYear} Memry. All rights reserved.
          </p>
          <p className="text-sm text-muted/60 font-mono-accent">
            Made with care at{' '}
            <a href="https://memrynote.com" className="text-terracotta hover:underline">
              memrynote.com
            </a>
          </p>
        </div>
      </Container>
    </footer>
  )
}
