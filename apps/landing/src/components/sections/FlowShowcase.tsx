import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Container } from '@/components/layout/Container'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { DemoTabs } from '@/components/demo/DemoTabs'
import { DemoScene } from '@/components/demo/DemoScene'
import { useShowcaseTimer } from '@/components/demo/hooks/useShowcaseTimer'
import { CLIPS } from '@/components/demo/types'
import { FLOW_STEPS } from '@/lib/constants'

const INTERACTIVE_STEPS = FLOW_STEPS.filter((s) => CLIPS.some((c) => c.id === s.id))

function CompetitorBar({ activeIndex }: { activeIndex: number }) {
  const step = INTERACTIVE_STEPS[activeIndex]
  const label = 'competitorLabel' in step ? (step.competitorLabel as string) : 'Replaces'

  return (
    <div className="h-8 flex items-center justify-center">
      <AnimatePresence mode="wait">
        <motion.div
          key={step.id}
          className="flex items-center gap-3"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="text-[11px] font-mono-accent uppercase tracking-wider text-muted/40">
            {label}
          </span>
          <div className="flex items-center gap-2">
            {step.competitors.map((c) => (
              <img
                key={c.name}
                src={c.logo}
                alt={c.name}
                title={c.name}
                className="w-[18px] h-[18px] rounded-sm opacity-60 hover:opacity-100 transition-opacity"
              />
            ))}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export function FlowShowcase() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [videoDuration, setVideoDuration] = useState<number | null>(null)

  const { progress, goTo } = useShowcaseTimer(activeIndex, setActiveIndex, paused, videoDuration)

  const handleStepClick = useCallback(
    (index: number) => {
      setVideoDuration(null)
      goTo(index)
      setPaused(false)
    },
    [goTo]
  )

  const handleToggle = useCallback(() => {
    setPaused((p) => !p)
  }, [])

  const handleDurationDetected = useCallback((ms: number) => {
    setVideoDuration(ms)
  }, [])

  return (
    <section>
      <Container>
        <div className="max-w-4xl mx-auto">
          <MockupFrame>
            <div className="flex flex-col">
              <div className="px-3 py-2 border-b border-border/30">
                <DemoTabs
                  activeIndex={activeIndex}
                  progress={progress}
                  onTabClick={handleStepClick}
                />
              </div>
              <DemoScene
                activeIndex={activeIndex}
                playing={!paused}
                onToggle={handleToggle}
                onDurationDetected={handleDurationDetected}
              />
            </div>
          </MockupFrame>

          <div className="mt-3">
            <CompetitorBar activeIndex={activeIndex} />
          </div>
        </div>
      </Container>
    </section>
  )
}
