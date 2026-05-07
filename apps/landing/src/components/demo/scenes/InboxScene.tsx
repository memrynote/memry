import { VideoScene } from './VideoScene'
import type { SceneProps } from '../types'

export function InboxScene({ playing, onDurationDetected }: SceneProps) {
  return (
    <VideoScene src="/demos/inbox.mp4" playing={playing} onDurationDetected={onDurationDetected} />
  )
}
