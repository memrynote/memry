import { useRef, useEffect, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, Volume2, VolumeX } from 'lucide-react'
import type { SceneProps } from '../types'
import { trackLandingEvent } from '@/lib/analytics'

interface VideoSceneProps extends SceneProps {
  src: string
}

export function VideoScene({
  clipId,
  src,
  playing,
  muted,
  onMutedChange,
  onDurationDetected,
  seekRequest
}: VideoSceneProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const modalVideoRef = useRef<HTMLVideoElement>(null)
  const playingRef = useRef(playing)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (playing && !expanded) {
      const attemptPlay = () => video.play().catch(() => {})

      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        attemptPlay()
      } else {
        video.addEventListener('canplay', attemptPlay, { once: true })
        return () => video.removeEventListener('canplay', attemptPlay)
      }
    } else {
      video.pause()
    }
  }, [playing, expanded])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !onDurationDetected || !video.duration) return
    onDurationDetected(video.duration * 1000)
  }, [onDurationDetected])

  const handleLoadedMetadata = () => {
    const video = videoRef.current
    if (!video || !onDurationDetected) return
    onDurationDetected(video.duration * 1000)
  }

  const handleCanPlay = () => {
    const video = videoRef.current
    if (!video || !playingRef.current || expanded) return
    video.play().catch(() => {})
  }

  const handleModalCanPlay = () => {
    const video = modalVideoRef.current
    if (!video || !playingRef.current) return
    video.play().catch(() => {})
  }

  useEffect(() => {
    const video = videoRef.current
    if (!seekRequest) return
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return

    const nextProgress = Math.min(Math.max(seekRequest.progress, 0), 1)
    video.currentTime = video.duration * nextProgress
    if (modalVideoRef.current) {
      modalVideoRef.current.currentTime = video.duration * nextProgress
    }

    if (playingRef.current && !expanded) {
      video.play().catch(() => {})
    }
  }, [expanded, seekRequest])

  useEffect(() => {
    const modalVideo = modalVideoRef.current
    if (!expanded || !modalVideo) return

    const inlineVideo = videoRef.current
    if (inlineVideo && Number.isFinite(inlineVideo.currentTime)) {
      modalVideo.currentTime = inlineVideo.currentTime
    }

    if (playing) {
      modalVideo.play().catch(() => {})
    } else {
      modalVideo.pause()
    }
  }, [expanded, playing, src])

  const handleMuteToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    trackLandingEvent(muted ? 'landing_demo_unmute' : 'landing_demo_mute', `demo:${clipId}`)
    onMutedChange(!muted)
  }

  const handleExpandToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (expanded) {
      closeExpanded()
      return
    }
    trackLandingEvent('landing_demo_expand', `demo:${clipId}`)
    setExpanded(true)
  }

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    closeExpanded()
  }

  const handleModalClick = (event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
  }

  const closeExpanded = () => {
    const inlineVideo = videoRef.current
    const modalVideo = modalVideoRef.current
    if (inlineVideo && modalVideo && Number.isFinite(modalVideo.currentTime)) {
      inlineVideo.currentTime = modalVideo.currentTime
    }
    setExpanded(false)
  }

  useEffect(() => {
    if (!expanded) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeExpanded()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [expanded])

  const VolumeIcon = muted ? VolumeX : Volume2
  const controlButtonClass =
    'flex h-9 w-9 items-center justify-center rounded-full border border-white/35 bg-paper/35 text-ink/90 shadow-[0_10px_30px_rgba(35,28,23,0.18)] backdrop-blur-xl transition-colors hover:bg-paper/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/50'
  const modal =
    expanded && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/75 p-4 backdrop-blur-xl"
            onClick={handleBackdropClick}
          >
            <div
              className="relative w-[94vw] max-w-7xl overflow-hidden rounded-2xl border border-white/20 bg-black shadow-2xl"
              onClick={handleModalClick}
            >
              <video
                ref={modalVideoRef}
                src={src}
                muted={muted}
                loop
                playsInline
                preload="auto"
                className="pointer-events-none h-auto max-h-[82vh] w-full scale-x-[1.035]"
                onCanPlay={handleModalCanPlay}
              />
              <div className="absolute top-4 end-4 z-10 flex gap-2">
                <button
                  type="button"
                  aria-label={muted ? 'Unmute demo video' : 'Mute demo video'}
                  aria-pressed={!muted}
                  onClick={handleMuteToggle}
                  className={controlButtonClass}
                >
                  <VolumeIcon className="h-4 w-4" strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  aria-label="Exit fullscreen demo video"
                  aria-pressed
                  onClick={handleExpandToggle}
                  className={controlButtonClass}
                >
                  <Minimize2 className="h-4 w-4" strokeWidth={1.8} />
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      : null

  return (
    <>
      <div className="relative overflow-hidden rounded-lg">
        <video
          ref={videoRef}
          src={src}
          muted={muted}
          loop
          playsInline
          preload="auto"
          className="pointer-events-none h-auto w-full scale-x-[1.035]"
          onLoadedMetadata={handleLoadedMetadata}
          onCanPlay={handleCanPlay}
        />
        <div className="absolute top-3 end-3 z-10 flex gap-2" aria-hidden={expanded}>
          <button
            type="button"
            aria-label={muted ? 'Unmute demo video' : 'Mute demo video'}
            aria-pressed={!muted}
            onClick={handleMuteToggle}
            className={controlButtonClass}
          >
            <VolumeIcon className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <button
            type="button"
            aria-label="Open fullscreen demo video"
            aria-pressed={false}
            onClick={handleExpandToggle}
            className={controlButtonClass}
          >
            <Maximize2 className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {modal}
    </>
  )
}
