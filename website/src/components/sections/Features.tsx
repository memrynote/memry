import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { FEATURES } from '@/lib/constants'
import { cn } from '@/lib/utils'

export function Features() {
  return (
    <section id="features" className="py-24">
      <Container>
        <SectionHeading
          title="Four pillars of thought"
          subtitle="Everything you need to capture, organize, and act on your ideas. Nothing you don't."
        />

        <div className="space-y-32">
          {FEATURES.map((feature, index) => (
            <motion.div
              key={feature.id}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-100px' }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                'grid md:grid-cols-2 gap-16 items-center',
                index % 2 === 1 && 'md:grid-flow-dense'
              )}
            >
              <div className={cn(index % 2 === 1 && 'md:col-start-2')}>
                <div className="flex items-center gap-4 mb-6">
                  <span className="flex items-center justify-center w-8 h-8 rounded-full border border-terracotta/30 text-terracotta font-serif text-lg">
                    {index + 1}
                  </span>
                  <h3 className="font-serif text-3xl md:text-4xl text-ink">{feature.title}</h3>
                </div>

                <div className="relative pl-6 mb-8 border-l-2 border-terracotta/20">
                  <p className="text-xl md:text-2xl text-terracotta font-serif italic leading-relaxed">
                    {feature.tagline}
                  </p>
                </div>

                <p className="text-muted text-lg leading-relaxed mb-8">{feature.description}</p>

                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-4">
                  {feature.highlights.map((highlight) => (
                    <li
                      key={highlight}
                      className="flex items-start gap-3 text-sm text-ink/80 font-medium"
                    >
                      <div className="w-1.5 h-1.5 mt-1.5 rounded-full bg-terracotta flex-shrink-0" />
                      {highlight}
                    </li>
                  ))}
                </ul>
              </div>

              <div className={cn('relative', index % 2 === 1 && 'md:col-start-1 md:row-start-1')}>
                <div
                  className={cn(
                    'absolute inset-0 bg-paper-alt rounded-2xl -z-10 transform scale-[1.03]',
                    index % 2 === 0
                      ? 'rotate-2 translate-x-2 translate-y-2'
                      : '-rotate-2 -translate-x-2 translate-y-2'
                  )}
                />
                <MockupFrame
                  imageSrc={feature.screenshot}
                  imageAlt={`${feature.title} feature screenshot`}
                />
              </div>
            </motion.div>
          ))}
        </div>
      </Container>
    </section>
  )
}
