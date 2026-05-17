import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { PRICING_TIERS } from '@/lib/constants'
import { scrollToLandingTarget } from '@/lib/smooth-scroll'
import { cn } from '@/lib/utils'

export function Pricing() {
  return (
    <section id="pricing" className="relative">
      <div className="h-[100px] bg-gradient-to-b from-paper-deep to-dark" />

      <div className="zone-dark py-24">
        <Container size="md">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-100px' }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
            className="text-center mb-16"
          >
            <h2 className="font-serif text-4xl md:text-5xl font-normal text-ink-inverted mb-6 relative inline-block">
              Simple, honest pricing
              <span className="absolute -bottom-2 left-1/4 right-1/4 h-px bg-terracotta/30" />
            </h2>
            <p className="text-xl text-dark-muted font-sans max-w-2xl mx-auto leading-relaxed">
              Local features stay free. Sync scales only when you need more room.
            </p>
          </motion.div>

          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            {PRICING_TIERS.map((tier, index) => (
              <motion.div
                key={tier.name}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.8, delay: index * 0.15, ease: [0.16, 1, 0.3, 1] }}
              >
                <Card
                  className={cn(
                    'h-full relative transition-all duration-300 bg-dark-surface',
                    tier.highlighted
                      ? 'border-terracotta shadow-glow-terracotta scale-[1.02] md:scale-105 z-10'
                      : 'border-dark-border hover:border-terracotta/30'
                  )}
                >
                  {tier.highlighted && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="bg-terracotta text-white text-xs font-mono-accent tracking-wider font-medium px-4 py-1 rounded-full uppercase">
                        Support us
                      </span>
                    </div>
                  )}

                  <CardHeader className="text-center pb-6 pt-8">
                    <CardTitle className="font-serif text-3xl font-normal text-ink-inverted">
                      {tier.name}
                    </CardTitle>
                    <div className="mt-4 flex items-baseline justify-center gap-1">
                      <span className="text-4xl font-mono-accent font-medium text-ink-inverted">
                        {tier.price}
                      </span>
                      <span className="text-dark-muted font-sans text-sm">{tier.period}</span>
                    </div>
                    {'yearlyPrice' in tier && tier.yearlyPrice && (
                      <p className="text-sm text-terracotta font-medium mt-1 font-mono-accent">
                        {tier.yearlyPrice}
                      </p>
                    )}
                    <CardDescription className="mt-4 text-base leading-relaxed text-dark-muted">
                      {tier.description}
                    </CardDescription>
                  </CardHeader>

                  <CardContent className="pt-2 pb-8 px-8">
                    <ul className="space-y-4 mb-8">
                      {tier.features.map((feature) => (
                        <li key={feature} className="flex items-start gap-3 text-sm">
                          <div className="mt-0.5 rounded-full border border-terracotta/30 p-0.5 shrink-0">
                            <Check className="w-3 h-3 text-terracotta" />
                          </div>
                          <span className="text-ink-inverted/80">{feature}</span>
                        </li>
                      ))}
                    </ul>

                    {tier.highlighted ? (
                      <Button
                        className="w-full font-medium bg-terracotta hover:bg-terracotta-dark text-white"
                        asChild
                      >
                        <a href="#waitlist">{tier.cta}</a>
                      </Button>
                    ) : (
                      <button
                        className="w-full font-medium py-2 px-4 rounded-md border border-dark-border text-ink-inverted hover:bg-dark-border transition-colors"
                        onClick={() => {
                          const waitlist = document.getElementById('waitlist')
                          if (waitlist) scrollToLandingTarget(waitlist)
                        }}
                      >
                        {tier.cta}
                      </button>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </Container>
      </div>
    </section>
  )
}
