import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'
import { DESKTOP_RELEASE_TIMING } from '@/lib/constants'

export function FinalCTA() {
  return (
    <section id="waitlist" className="zone-dark py-32 relative overflow-hidden">
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
            Join the <span className="italic text-terracotta">waitlist.</span>
          </h2>
          <p className="text-xl text-dark-muted font-sans mb-12 max-w-lg mx-auto leading-relaxed">
            Desktop app {DESKTOP_RELEASE_TIMING.toLowerCase()}.
          </p>

          <div className="conic-border rounded-xl overflow-hidden bg-dark-surface max-w-md mx-auto">
            <div className="p-1">
              <WaitlistForm variant="centered" />
            </div>
          </div>

          <p className="text-sm text-dark-muted/60 mt-6 font-mono-accent">
            We'll never spam. Unsubscribe anytime.
          </p>

          <p className="mt-16 font-mono-accent text-[10px] uppercase tracking-[0.3em] text-dark-muted/50">
            memrynote · local-first · open source · <span className="italic normal-case">fin.</span>
          </p>
        </motion.div>
      </Container>
    </section>
  )
}
