import { VideoScene } from './VideoScene'
import type { SceneProps } from '../types'

export function JournalScene({ playing, onDurationDetected }: SceneProps) {
  return (
    <VideoScene
      src="/demos/journal.mp4"
      playing={playing}
      onDurationDetected={onDurationDetected}
    />
  )
}
