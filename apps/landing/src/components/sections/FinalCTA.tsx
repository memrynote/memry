import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { DownloadCTA } from '@/components/shared/DownloadCTA'

export function FinalCTA() {
  return (
    <section className="zone-dark py-32 relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(circle at 50% 40%, rgb(255 103 26 / 0.08), transparent 60%)'
        }}
      />

      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-px bg-terracotta" />

      <Container size="sm">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="text-center"
        >
          <p aria-hidden className="mb-8 font-serif text-2xl tracking-[0.5em] text-terracotta">
            ⁂
          </p>
          <h2 className="font-serif text-6xl md:text-7xl font-normal text-ink-inverted mb-6">
            Get <span className="italic text-terracotta">memrynote.</span>
          </h2>
          <p className="text-xl text-dark-muted font-sans mb-12 max-w-lg mx-auto leading-relaxed">
            Free, local-first, and open source. Yours in under a minute.
          </p>

          <DownloadCTA location="home-final" tone="inverted" />

          <p className="mt-16 font-mono-accent text-[10px] uppercase tracking-[0.3em] text-dark-muted/50">
            memrynote · local-first · open source · <span className="italic normal-case">fin.</span>
          </p>
        </motion.div>
      </Container>
    </section>
  )
}
