import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { WaitlistForm } from '@/components/shared/WaitlistForm'

const benefits = ['Free to start', 'Own your data', 'E2EE protected']

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.1
    }
  }
}

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.8,
      ease: [0.16, 1, 0.3, 1] as const
    }
  }
}

export function Hero() {
  return (
    <section id="hero" className="pt-32 pb-20 md:pt-40 md:pb-28 overflow-hidden">
      <Container>
        <motion.div
          className="max-w-4xl mx-auto text-center mb-16"
          variants={containerVariants}
          initial="hidden"
          animate="show"
        >
          <motion.h1
            variants={itemVariants}
            className="font-serif text-5xl md:text-7xl font-normal text-ink mb-8 leading-[1.1] tracking-tight text-balance"
          >
            Your thoughts,{' '}
            <span className="text-terracotta italic relative inline-block">
              beautifully organized
              <svg
                className="absolute w-full h-3 -bottom-1 left-0 text-terracotta/30"
                viewBox="0 0 100 10"
                preserveAspectRatio="none"
              >
                <path d="M0 5 Q 50 10 100 5" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
            </span>
            .
          </motion.h1>

          <motion.p
            variants={itemVariants}
            className="text-xl md:text-2xl text-muted font-sans max-w-2xl mx-auto mb-10 leading-relaxed"
          >
            The local-first PKM that combines task management, journaling, and note-taking in one
            warm, focused space.
          </motion.p>

          <motion.div variants={itemVariants} className="max-w-md mx-auto mb-8" id="waitlist">
            <WaitlistForm variant="hero" />
          </motion.div>

          <motion.div
            variants={itemVariants}
            className="flex flex-wrap items-center justify-center gap-6 md:gap-8 text-sm text-muted font-mono-accent uppercase tracking-wide"
          >
            {benefits.map((benefit) => (
              <div key={benefit} className="flex items-center gap-2">
                <div className="rounded-full border border-terracotta/40 p-0.5">
                  <Check className="w-3 h-3 text-terracotta" />
                </div>
                <span>{benefit}</span>
              </div>
            ))}
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 1.2, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-6xl mx-auto relative z-10"
        >
          <div className="absolute -inset-4 bg-terracotta/5 blur-3xl rounded-full -z-10" />
          <MockupFrame
            imageSrc="/placeholders/hero-screenshot.png"
            imageAlt="Memry app interface"
          />
        </motion.div>
      </Container>
    </section>
  )
}
