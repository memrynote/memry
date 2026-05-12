import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'

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
          <h2 className="font-serif text-6xl md:text-7xl font-normal text-ink-inverted mb-6">
            Join the waitlist
          </h2>
          <p className="text-xl text-dark-muted font-sans mb-12 max-w-lg mx-auto leading-relaxed">
            Be the first to know when Memry is ready.
          </p>

          <div className="conic-border rounded-xl overflow-hidden bg-dark-surface max-w-md mx-auto">
            <div className="p-1">
              <WaitlistForm variant="centered" />
            </div>
          </div>

          <p className="text-sm text-dark-muted/60 mt-6 font-mono-accent">
            We'll never spam. Unsubscribe anytime.
          </p>
        </motion.div>
      </Container>
    </section>
  )
}
