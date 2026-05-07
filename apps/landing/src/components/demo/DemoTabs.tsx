import { motion, type MotionValue, useTransform } from 'framer-motion'
import { Inbox, BookOpen, FileText, CheckSquare } from 'lucide-react'
import { CLIPS, type TabId } from './types'

const TAB_ICONS: Record<TabId, typeof Inbox> = {
  inbox: Inbox,
  journal: BookOpen,
  notes: FileText,
  tasks: CheckSquare
}

interface DemoTabsProps {
  activeIndex: number
  progress: MotionValue<number>
  onTabClick: (index: number) => void
}

function TabFill({ progress }: { progress: MotionValue<number> }) {
  const scaleX = useTransform(progress, [0, 1], [0, 1])

  return (
    <motion.div
      className="absolute inset-0 bg-terracotta/15 rounded-lg origin-left"
      style={{ scaleX }}
    />
  )
}

export function DemoTabs({ activeIndex, progress, onTabClick }: DemoTabsProps) {
  return (
    <div className="flex gap-1 p-1 bg-paper-alt rounded-xl border border-border/50">
      {CLIPS.map((clip, index) => {
        const Icon = TAB_ICONS[clip.id]
        const isActive = index === activeIndex
        const isCompleted = index < activeIndex

        return (
          <button
            key={clip.id}
            onClick={() => onTabClick(index)}
            className="relative flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-mono-accent transition-colors cursor-pointer hover:bg-terracotta/[0.06]"
          >
            {isActive && <TabFill progress={progress} />}
            {isCompleted && <div className="absolute inset-0 bg-terracotta/10 rounded-lg" />}

            <span className="relative z-10 flex items-center gap-2">
              <Icon
                className={`w-4 h-4 ${isActive ? 'text-terracotta' : 'text-muted/60'}`}
                strokeWidth={1.5}
              />
              <span className={`hidden sm:inline ${isActive ? 'text-ink' : 'text-muted/60'}`}>
                {clip.label}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
