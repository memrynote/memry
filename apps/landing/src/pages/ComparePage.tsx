import { Link } from 'react-router'
import { motion } from 'motion/react'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { ALTERNATIVES, COMPARE_CARDS } from '@/lib/alternatives'
import { PAGE_META } from '@/lib/seo'

const REVEAL = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const }
}

export function ComparePage() {
  return (
    <>
      <PageHead page="compare" />

      <section className="pt-28 pb-12 md:pt-36 md:pb-16">
        <Container size="lg">
          <motion.div {...REVEAL} className="max-w-3xl">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              Compare
            </p>
            <h1 className="mt-4 font-serif text-4xl leading-[1.08] text-ink text-balance md:text-5xl">
              memrynote vs <span className="italic text-terracotta">the rest.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
              Pick the app you use today and see how it stacks up — a local-first, end-to-end
              encrypted workspace that puts notes, tasks, a calendar, and a daily journal in one
              place, as plain Markdown files you own.
            </p>
          </motion.div>
        </Container>
      </section>

      <section className="pb-24 zone-transition">
        <Container size="lg">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ALTERNATIVES.map((alt) => {
              const { path } = PAGE_META[alt.pageKey]
              const card = COMPARE_CARDS[alt.pageKey]
              return (
                <motion.div key={alt.pageKey} {...REVEAL}>
                  <Link
                    to={path}
                    className="group flex h-full flex-col items-center rounded-sm border border-ink/10 bg-paper/60 p-8 text-center transition-colors hover:border-terracotta/40 hover:bg-terracotta/[0.04]"
                  >
                    <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-ink/10 bg-white shadow-sm">
                      <img
                        src={`/compare-logos/${card.logo}`}
                        alt={`${alt.competitor} logo`}
                        width={36}
                        height={36}
                        loading="lazy"
                        className="h-9 w-9 object-contain"
                      />
                    </span>
                    <span className="mt-5 font-serif text-xl text-ink">
                      memrynote vs {alt.competitor}
                    </span>
                    <span className="mt-2 text-sm leading-relaxed text-muted">{card.tagline}</span>
                    <span className="mt-5 inline-flex items-center gap-1.5 font-mono-accent text-xs uppercase tracking-[0.18em] text-terracotta">
                      Compare
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" />
                    </span>
                  </Link>
                </motion.div>
              )
            })}
          </div>
        </Container>
      </section>
    </>
  )
}
