import { motion } from 'framer-motion'
import { CLIPS, type SeekRequest } from './types'
import { InboxScene } from './scenes/InboxScene'
import { JournalScene } from './scenes/JournalScene'
import { NotesScene } from './scenes/NotesScene'
import { TasksScene } from './scenes/TasksScene'

const SCENE_MAP = {
  inbox: InboxScene,
  journal: JournalScene,
  notes: NotesScene,
  tasks: TasksScene
} as const

interface DemoSceneProps {
  activeIndex: number
  playing: boolean
  muted: boolean
  onToggle: () => void
  onMutedChange: (muted: boolean) => void
  onDurationDetected: (ms: number) => void
  seekRequest: SeekRequest | null
}

export function DemoScene({
  activeIndex,
  playing,
  muted,
  onToggle,
  onMutedChange,
  onDurationDetected,
  seekRequest
}: DemoSceneProps) {
  return (
    <div
      className="relative bg-paper-deep rounded-b-xl overflow-hidden select-none aspect-video"
      onClick={onToggle}
    >
      {CLIPS.map((clip, i) => {
        const Scene = SCENE_MAP[clip.id]
        const isActive = i === activeIndex
        return (
          <motion.div
            key={clip.id}
            className="absolute inset-0"
            animate={{ opacity: isActive ? 1 : 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            style={{ pointerEvents: isActive ? 'auto' : 'none' }}
          >
            <Scene
              playing={isActive && playing}
              muted={muted}
              onMutedChange={onMutedChange}
              onDurationDetected={isActive ? onDurationDetected : undefined}
              seekRequest={isActive ? seekRequest : null}
            />
          </motion.div>
        )
      })}
    </div>
  )
}
