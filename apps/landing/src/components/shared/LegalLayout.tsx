import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'

interface LegalLayoutProps {
  eyebrow: string
  title: string
  intro: string
  lastUpdated: string
  children: ReactNode
}

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

export function LegalLayout({ eyebrow, title, intro, lastUpdated, children }: LegalLayoutProps) {
  return (
    <main>
      <section className="relative overflow-hidden pt-32 pb-12 sm:pt-40 sm:pb-16">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[360px] bg-[radial-gradient(ellipse_at_top,rgba(255,103,26,0.08),transparent_60%)]"
        />
        <Container size="sm">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE_OUT_EXPO }}
            className="text-center"
          >
            <p className="font-mono-accent text-[11px] uppercase tracking-[0.32em] text-terracotta">
              {eyebrow}
            </p>
            <h1 className="mt-5 font-serif text-4xl font-normal leading-[1.05] text-ink text-balance md:text-6xl">
              {title}
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted text-balance">
              {intro}
            </p>
            <p className="mt-8 font-mono-accent text-[11px] uppercase tracking-[0.18em] text-muted/70">
              Last updated · {lastUpdated}
            </p>
          </motion.div>
        </Container>
      </section>

      <section className="pb-28">
        <Container size="sm">
          <motion.article
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.1, ease: EASE_OUT_EXPO }}
            className="legal-prose"
          >
            {children}
          </motion.article>
        </Container>
      </section>
    </main>
  )
}
