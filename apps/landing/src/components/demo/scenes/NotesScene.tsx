import { VideoScene } from './VideoScene'
import type { SceneProps } from '../types'

export function NotesScene({ playing, onDurationDetected }: SceneProps) {
  return (
    <VideoScene src="/demos/note.mp4" playing={playing} onDurationDetected={onDurationDetected} />
  )
}
