import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { PageHead } from '@/components/shared/PageHead'
import { ALTERNATIVES } from '@/lib/alternatives'
import { PAGE_META } from '@/lib/seo'

const REVEAL = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const }
}

export function AlternativesHubPage() {
  return (
    <>
      <PageHead page="alternativesHub" />

      <section className="pt-28 pb-12 md:pt-36 md:pb-16">
        <Container size="md">
          <motion.div {...REVEAL} className="max-w-3xl">
            <p className="font-mono-accent text-xs uppercase tracking-[0.22em] text-terracotta">
              Alternatives
            </p>
            <h1 className="mt-4 font-serif text-4xl leading-[1.08] text-ink text-balance md:text-5xl">
              memrynote vs <span className="italic text-terracotta">the rest.</span>
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
              How memrynote compares to the note apps people switch from — a local-first, end-to-end
              encrypted workspace that puts notes, tasks, a calendar, and a daily journal in one
              place, as plain Markdown files you own.
            </p>
          </motion.div>
        </Container>
      </section>

      <section className="py-16 zone-transition">
        <Container size="md">
          <div className="grid gap-4 sm:grid-cols-2">
            {ALTERNATIVES.map((alt) => {
              const { path } = PAGE_META[alt.pageKey]
              return (
                <motion.div key={alt.pageKey} {...REVEAL}>
                  <Link
                    to={path}
                    className="group flex items-center justify-between gap-4 rounded-sm border border-ink/10 bg-paper/60 p-6 transition-colors hover:border-terracotta/40 hover:bg-terracotta/5"
                  >
                    <span>
                      <span className="font-serif text-xl text-ink">
                        memrynote vs {alt.competitor}
                      </span>
                      <span className="mt-1 block text-sm text-muted">
                        The {alt.competitor} alternative
                      </span>
                    </span>
                    <ArrowRight className="h-5 w-5 flex-none text-terracotta transition-transform group-hover:translate-x-1" />
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
