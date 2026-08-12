import { motion } from 'motion/react'
import { Play } from 'lucide-react'
import type { MouseEvent } from 'react'
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
  onStart?: () => void
  onMutedChange: (muted: boolean) => void
  onDurationDetected: (ms: number) => void
  onPlaybackChange?: (playing: boolean) => void
  onProgressChange?: (progress: number) => void
  previewing?: boolean
  seekRequest: SeekRequest | null
}

export function DemoScene({
  activeIndex,
  playing,
  muted,
  onToggle,
  onStart,
  onMutedChange,
  onDurationDetected,
  onPlaybackChange,
  onProgressChange,
  previewing = false,
  seekRequest
}: DemoSceneProps) {
  const handleClick = () => {
    if (previewing) {
      onStart?.()
      return
    }

    onToggle()
  }

  const handlePlayClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    onStart?.()
  }

  return (
    <div
      className="relative bg-paper-deep rounded-b-xl overflow-hidden select-none aspect-video"
      onClick={handleClick}
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
              clipId={clip.id}
              playing={isActive && playing}
              muted={muted}
              onMutedChange={onMutedChange}
              onDurationDetected={isActive ? onDurationDetected : undefined}
              onPlaybackChange={isActive ? onPlaybackChange : undefined}
              onProgressChange={isActive ? onProgressChange : undefined}
              seekRequest={isActive ? seekRequest : null}
            />
          </motion.div>
        )
      })}
      {previewing && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper/10 backdrop-blur-[2px]">
          <button
            type="button"
            aria-label="Play demo video"
            onClick={handlePlayClick}
            className="group flex h-20 w-20 items-center justify-center rounded-full border border-white/55 bg-paper/40 text-ink shadow-[0_24px_70px_rgba(35,28,23,0.28)] backdrop-blur-2xl transition duration-200 hover:scale-[1.04] hover:bg-paper/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/55"
          >
            <Play
              className="ms-1 h-9 w-9 fill-current text-terracotta transition-transform duration-200 group-hover:scale-105"
              strokeWidth={1.6}
            />
          </button>
        </div>
      )}
    </div>
  )
}
