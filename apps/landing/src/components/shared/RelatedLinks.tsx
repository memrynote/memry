import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'

export interface RelatedLink {
  label: string
  href: string
  description: string
}

export function RelatedLinks({ title, links }: { title: string; links: readonly RelatedLink[] }) {
  return (
    <nav aria-label={title}>
      <h2 className="font-serif text-2xl text-ink md:text-3xl">{title}</h2>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              to={link.href}
              className="group flex h-full flex-col rounded-2xl border border-border/60 bg-card p-5 transition-colors hover:border-terracotta/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
            >
              <span className="inline-flex items-center gap-1.5 font-serif text-lg leading-snug text-ink group-hover:text-terracotta">
                {link.label}
                <ArrowRight className="h-4 w-4 shrink-0 rtl:rotate-180" aria-hidden />
              </span>
              <span className="mt-2 text-sm leading-relaxed text-muted">{link.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
