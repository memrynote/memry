import { motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { SectionHeading } from '@/components/shared/SectionHeading'
import { PageHead } from '@/components/shared/PageHead'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { PRICING_TIERS } from '@/lib/constants'
import { cn } from '@/lib/utils'

const pricingFAQ = [
  {
    question: 'Can I switch between plans?',
    answer:
      "Yes! You can upgrade to Supporter at any time, or cancel and continue using the free tier. Your data stays yours regardless of which plan you're on."
  },
  {
    question: 'What happens if I cancel my Supporter subscription?',
    answer:
      'You keep all your data and can continue using Memry with all features. The Supporter tier is about supporting development and getting early access, not unlocking features.'
  },
  {
    question: 'Do you offer refunds?',
    answer:
      'Yes, we offer a 30-day money-back guarantee for annual subscriptions. Monthly subscriptions can be cancelled anytime.'
  },
  {
    question: 'Is there a team or enterprise plan?',
    answer:
      "We're focused on individual users for now, but team features are on our roadmap. Join the waitlist to stay updated."
  }
]

export function PricingPage() {
  return (
    <main className="pt-24">
      <PageHead page="pricing" />
      <section className="py-16">
        <Container size="md">
          <SectionHeading
            title="Simple, honest pricing"
            subtitle="Memry is free forever. The Supporter tier helps fund development and gives you early access to new features."
          />

          <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto mb-16">
            {PRICING_TIERS.map((tier, index) => (
              <motion.div
                key={tier.name}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
              >
                <Card
                  className={cn('h-full relative', tier.highlighted && 'border-primary shadow-lg')}
                >
                  {tier.highlighted && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">
                        Support us
                      </span>
                    </div>
                  )}

                  <CardHeader className="text-center pb-2">
                    <CardTitle className="text-xl">{tier.name}</CardTitle>
                    <div className="mt-4">
                      <span className="text-4xl font-bold text-foreground">{tier.price}</span>
                      <span className="text-muted ml-1">{tier.period}</span>
                    </div>
                    {'yearlyPrice' in tier && tier.yearlyPrice && (
                      <p className="text-sm text-muted mt-1">or {tier.yearlyPrice}</p>
                    )}
                    <CardDescription className="mt-3">{tier.description}</CardDescription>
                  </CardHeader>

                  <CardContent className="pt-4">
                    <ul className="space-y-3 mb-6">
                      {tier.features.map((feature) => (
                        <li key={feature} className="flex items-start gap-3 text-sm">
                          <Check className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                          <span className="text-muted">{feature}</span>
                        </li>
                      ))}
                    </ul>

                    <Button
                      variant={tier.highlighted ? 'default' : 'secondary'}
                      className="w-full"
                      asChild
                    >
                      <a href="/#waitlist">{tier.cta}</a>
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>

          <div className="max-w-2xl mx-auto">
            <h3 className="text-xl font-semibold text-foreground text-center mb-8">Pricing FAQ</h3>
            <Accordion type="single" collapsible className="w-full">
              {pricingFAQ.map((item, index) => (
                <AccordionItem key={index} value={`item-${index}`}>
                  <AccordionTrigger className="text-left text-foreground">
                    {item.question}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted leading-relaxed">
                    {item.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </Container>
      </section>
    </main>
  )
}
