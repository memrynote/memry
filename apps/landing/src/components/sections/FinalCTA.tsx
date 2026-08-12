import { motion } from 'motion/react'
import { Container } from '@/components/layout/Container'
import { DownloadCTA } from '@/components/shared/DownloadCTA'

export function FinalCTA() {
  return (
    <section className="zone-dark relative overflow-hidden py-28 md:py-36">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(circle at 50% 45%, rgb(255 103 26 / 0.07), transparent 60%)'
        }}
        aria-hidden
      />

      <Container size="sm">
        <motion.div
          initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }}
          whileInView={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="relative text-center"
        >
          <h2 className="font-serif text-5xl text-ink-inverted md:text-6xl">
            Ready when <em className="text-terracotta">you are.</em>
          </h2>
          <p className="mx-auto mt-6 max-w-md text-lg leading-relaxed text-dark-muted">
            Free, local-first, and open source. Download it, pick a vault, and keep the thread.
          </p>

          <div className="mt-10">
            <DownloadCTA location="home-final" tone="inverted" />
          </div>

          <p className="mt-14 font-mono-accent text-[10px] uppercase tracking-[0.28em] text-dark-muted/60">
            macOS · Windows · Linux
          </p>
        </motion.div>
      </Container>
    </section>
  )
}
