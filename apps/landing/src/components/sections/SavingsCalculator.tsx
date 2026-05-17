import { useState, useEffect } from 'react'
import { motion, useSpring, useTransform, AnimatePresence } from 'framer-motion'
import { Check, ArrowRight } from 'lucide-react'
import { Container } from '@/components/layout/Container'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const BUNDLES = [
  {
    id: 'note-taker',
    label: 'Note Taker',
    description: 'Notes + journaling basics',
    tools: [
      { name: 'Notion Personal Pro', price: 10 },
      { name: 'Day One Premium', price: 4 }
    ]
  },
  {
    id: 'productivity-pro',
    label: 'Productivity Pro',
    description: 'Notes + tasks + journaling',
    tools: [
      { name: 'Notion', price: 10 },
      { name: 'Todoist Pro', price: 5 },
      { name: 'Day One', price: 4 }
    ]
  },
  {
    id: 'knowledge-worker',
    label: 'Knowledge Worker',
    description: 'Full PKM stack',
    tools: [
      { name: 'Obsidian Sync', price: 8 },
      { name: 'Todoist Pro', price: 5 },
      { name: 'Day One', price: 4 },
      { name: 'Readwise', price: 8 }
    ]
  },
  {
    id: 'power-user',
    label: 'Power User',
    description: 'Premium everything',
    tools: [
      { name: 'Notion', price: 10 },
      { name: 'Things 3', price: 4 },
      { name: 'Obsidian Sync', price: 8 },
      { name: 'Day One', price: 4 }
    ]
  }
] as const

function AnimatedNumber({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 100, damping: 30 })
  const display = useTransform(spring, (current) => Math.round(current))
  const [displayValue, setDisplayValue] = useState(value)

  useEffect(() => {
    spring.set(value)
  }, [spring, value])

  useEffect(() => {
    return display.on('change', (latest) => {
      setDisplayValue(latest)
    })
  }, [display])

  return <>{displayValue}</>
}

const toolItemVariants = {
  hidden: { opacity: 0, x: 40, rotate: -3, scale: 0.9 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    rotate: 0,
    scale: 1,
    transition: {
      delay: i * 0.06,
      duration: 0.4,
      ease: [0.16, 1, 0.3, 1] as const
    }
  }),
  exit: { opacity: 0, x: -20, transition: { duration: 0.15 } }
}

export function SavingsCalculator() {
  const [selectedId, setSelectedId] = useState<string>(BUNDLES[1].id)
  const selected = BUNDLES.find((b) => b.id === selectedId)!
  const monthlyCost = selected.tools.reduce((sum, t) => sum + t.price, 0)
  const annualSavings = monthlyCost * 12
  const bounceKey = selectedId

  return (
    <section className="py-24 bg-paper-alt/30">
      <Container>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <h2 className="font-serif text-4xl md:text-5xl font-normal text-ink mb-6 relative inline-block">
            Replace your tool stack
            <span className="absolute -bottom-2 left-1/4 right-1/4 h-px bg-terracotta/30" />
          </h2>
          <p className="text-xl text-muted font-sans max-w-2xl mx-auto leading-relaxed">
            Pick the setup closest to yours. See what Memry saves you.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="max-w-3xl mx-auto"
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {BUNDLES.map((bundle) => {
              const isActive = bundle.id === selectedId
              const total = bundle.tools.reduce((s, t) => s + t.price, 0)
              return (
                <button
                  key={bundle.id}
                  type="button"
                  onClick={() => setSelectedId(bundle.id)}
                  className={cn(
                    'relative p-4 rounded-xl border-2 transition-all text-left',
                    isActive
                      ? 'border-terracotta bg-terracotta/5 shadow-sm'
                      : 'border-border hover:border-terracotta/40 hover:bg-paper-alt'
                  )}
                >
                  {isActive && (
                    <motion.div
                      layoutId="bundle-indicator"
                      className="absolute top-3 right-3 w-5 h-5 rounded-full bg-terracotta flex items-center justify-center"
                      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                    >
                      <Check className="w-3 h-3 text-white" />
                    </motion.div>
                  )}
                  <span className="text-sm font-semibold text-ink block mb-1">{bundle.label}</span>
                  <span className="text-xs text-muted block mb-2">{bundle.description}</span>
                  <span className="text-sm font-medium text-ink">${total}/mo</span>
                </button>
              )
            })}
          </div>

          <div className="bg-card/50 rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="p-6 md:p-8">
              <div className="grid grid-cols-1 md:grid-cols-[1fr,auto,1fr] gap-6 items-center">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={selectedId}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <p className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
                      Your current stack
                    </p>
                    <div className="space-y-2">
                      {selected.tools.map((tool, i) => (
                        <motion.div
                          key={tool.name}
                          custom={i}
                          variants={toolItemVariants}
                          initial="hidden"
                          animate="visible"
                          className="flex items-center justify-between py-2 px-3 rounded-lg bg-red-50/60 dark:bg-red-950/20"
                        >
                          <span className="text-sm text-ink">{tool.name}</span>
                          <span className="text-sm font-medium text-red-600 dark:text-red-400">
                            ${tool.price}/mo
                          </span>
                        </motion.div>
                      ))}
                      <div className="flex items-center justify-between pt-2 border-t border-border">
                        <span className="text-sm font-medium text-muted">Total</span>
                        <span className="text-base font-bold text-ink">${monthlyCost}/mo</span>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>

                <div className="hidden md:flex flex-col items-center gap-2">
                  <motion.div
                    animate={{ x: [0, 5, 0] }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <ArrowRight className="w-6 h-6 text-terracotta" />
                  </motion.div>
                </div>

                <div className="text-center md:text-left">
                  <p className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
                    With Memry
                  </p>
                  <motion.div
                    className="py-4 px-5 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-200/50 dark:border-emerald-800/30"
                    animate={{
                      boxShadow: [
                        '0 0 20px -5px rgb(255 103 26 / 0.3)',
                        '0 0 30px -5px rgb(255 103 26 / 0.6)',
                        '0 0 20px -5px rgb(255 103 26 / 0.3)'
                      ]
                    }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <p className="text-3xl font-serif font-bold text-emerald-600 dark:text-emerald-400 mb-1">
                      $0
                    </p>
                    <p className="text-sm text-emerald-700/70 dark:text-emerald-300/70">
                      Free plan covers it all
                    </p>
                  </motion.div>
                </div>
              </div>
            </div>

            <div className="px-6 md:px-8 py-5 bg-paper-alt/30 border-t border-border">
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-baseline gap-6 text-center sm:text-left">
                  <div>
                    <span className="text-xs text-muted block">Monthly</span>
                    <span className="text-2xl font-serif font-bold text-ink">
                      $<AnimatedNumber value={monthlyCost} />
                    </span>
                    <span className="text-sm text-muted"> saved</span>
                  </div>
                  <div>
                    <span className="text-xs text-muted block">Yearly</span>
                    <motion.span
                      key={bounceKey}
                      className="text-2xl font-serif font-bold text-emerald-600 inline-block"
                      initial={{ scale: 1 }}
                      animate={{ scale: [1, 1.15, 1] }}
                      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                    >
                      $<AnimatedNumber value={annualSavings} />
                    </motion.span>
                    <span className="text-sm text-muted"> saved</span>
                  </div>
                </div>
                <Button size="lg" asChild>
                  <a href="#waitlist">
                    Start saving with Memry
                    <span className="ml-2">→</span>
                  </a>
                </Button>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted text-center mt-4">
            Prices based on published monthly plans as of 2025. Things 3 one-time cost amortized
            over 12 months.
          </p>
        </motion.div>
      </Container>
    </section>
  )
}
