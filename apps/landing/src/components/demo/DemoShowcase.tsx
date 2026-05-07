import { useState, useCallback } from 'react'
import { MockupFrame } from '@/components/shared/MockupFrame'
import { DemoTabs } from './DemoTabs'
import { DemoScene } from './DemoScene'
import { useShowcaseTimer } from './hooks/useShowcaseTimer'

export function DemoShowcase() {
  const [activeIndex, setActiveIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [videoDuration, setVideoDuration] = useState<number | null>(null)

  const { progress, goTo } = useShowcaseTimer(activeIndex, setActiveIndex, paused, videoDuration)

  const handleTabClick = useCallback(
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
    <MockupFrame>
      <div className="flex flex-col">
        <div className="px-3 py-2 border-b border-border/30">
          <DemoTabs activeIndex={activeIndex} progress={progress} onTabClick={handleTabClick} />
        </div>
        <DemoScene
          activeIndex={activeIndex}
          playing={!paused}
          onToggle={handleToggle}
          onDurationDetected={handleDurationDetected}
        />
      </div>
    </MockupFrame>
  )
}
