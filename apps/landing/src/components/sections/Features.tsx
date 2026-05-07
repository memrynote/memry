import { Fragment } from 'react'
import { motion } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { FEATURES } from '@/lib/constants'
import { cn } from '@/lib/utils'

function FlowConnector({ index }: { index: number }) {
  const isEven = index % 2 === 0

  return (
    <div className="my-4">
      <div className="hidden md:block">
        <svg className="w-full h-24" viewBox="0 0 800 200" fill="none">
          <motion.path
            d={isEven ? 'M 200,10 C 200,100 600,100 600,190' : 'M 600,10 C 600,100 200,100 200,190'}
            stroke="var(--color-terracotta)"
            strokeWidth="1.5"
            strokeOpacity="0.2"
            strokeDasharray="8 6"
            strokeLinecap="round"
            fill="none"
            initial={{ pathLength: 0 }}
            whileInView={{ pathLength: 1 }}
            viewport={{ once: true, margin: '-20px' }}
            transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
          />
          <motion.circle
            cx={isEven ? 600 : 200}
            cy={190}
            r={4}
            fill="var(--color-terracotta)"
            fillOpacity={0.25}
            initial={{ opacity: 0, scale: 0 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 1.2, duration: 0.4 }}
          />
        </svg>
      </div>

      <div className="md:hidden flex justify-center">
        <motion.svg
          width="2"
          height="48"
          viewBox="0 0 2 48"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <line
            x1="1"
            y1="0"
            x2="1"
            y2="48"
            stroke="var(--color-terracotta)"
            strokeWidth="1"
            strokeOpacity="0.2"
            strokeDasharray="4 4"
          />
        </motion.svg>
      </div>
    </div>
  )
}

export function Features() {
  return (
    <section id="features" className="py-24">
      <Container>
        <SectionHeading
          title="What's inside"
          subtitle="Everything you need to capture, organize, and act on your ideas. Nothing you don't."
        />

        <div>
          {FEATURES.map((feature, index) => (
            <Fragment key={feature.id}>
              {index > 0 && <FlowConnector index={index - 1} />}
              <motion.div
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true, margin: '-100px' }}
                transition={{ duration: 0.5 }}
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
            </Fragment>
          ))}
        </div>
      </Container>
    </section>
  )
}
