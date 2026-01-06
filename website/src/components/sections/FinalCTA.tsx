import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { WaitlistForm } from '@/components/shared/WaitlistForm'

export function FinalCTA() {
  return (
    <section className="py-32 bg-paper relative overflow-hidden">
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-px bg-terracotta" />

      <Container size="sm">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-50px' }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="text-center"
        >
          <h2 className="font-serif text-5xl md:text-6xl font-normal text-ink mb-6">
            Ready to think beautifully?
          </h2>
          <p className="text-xl text-muted font-sans mb-12 max-w-lg mx-auto leading-relaxed">
            Join thousands of others waiting for early access to a calmer digital mind.
          </p>

          <WaitlistForm variant="centered" />

          <p className="text-sm text-muted/60 mt-6 font-mono-accent">
            We'll never spam. Unsubscribe anytime.
          </p>
        </motion.div>
      </Container>
    </section>
  )
}
