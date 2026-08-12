import { motion } from 'motion/react'
import { Container } from '@/components/layout/Container'
import { DemoPlayer } from '@/components/demo/DemoPlayer'
import { BLUR_REVEAL_ANIMATE, BLUR_REVEAL_INITIAL, BLUR_REVEAL_TRANSITION } from '@/lib/motion'

export function FlowShowcase() {
  return (
    <section className="pt-8 pb-4 md:pt-12">
      <Container>
        <motion.div
          className="mx-auto max-w-6xl"
          initial={BLUR_REVEAL_INITIAL}
          animate={BLUR_REVEAL_ANIMATE}
          transition={BLUR_REVEAL_TRANSITION}
        >
          <p className="mb-5 text-center font-mono-accent text-[11px] uppercase tracking-[0.2em] text-muted/70">
            The app, unedited — no mockups
          </p>

          <DemoPlayer />
        </motion.div>
      </Container>
    </section>
  )
}
