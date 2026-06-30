import { useRef, useEffect, useState, type MouseEvent, type PointerEvent } from 'react'
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
  onPlaybackChange,
  onProgressChange,
  seekRequest
}: VideoSceneProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const modalVideoRef = useRef<HTMLVideoElement>(null)
  const playingRef = useRef(playing)
  const closingExpandedRef = useRef(false)
  const modalSeekingRef = useRef(false)
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

  const syncInlineTimeFromModal = (modalVideo: HTMLVideoElement) => {
    const inlineVideo = videoRef.current
    if (!inlineVideo || !Number.isFinite(modalVideo.currentTime)) return

    inlineVideo.currentTime = modalVideo.currentTime
  }

  const reportProgressFor = (video: HTMLVideoElement | null) => {
    if (!video || !onProgressChange || !Number.isFinite(video.duration) || video.duration <= 0) {
      return
    }

    if (video === modalVideoRef.current) {
      syncInlineTimeFromModal(video)
    }

    onProgressChange(Math.min(Math.max(video.currentTime / video.duration, 0), 1))
  }

  const reportInlineProgress = () => {
    reportProgressFor(videoRef.current)
  }

  const reportModalProgress = () => {
    reportProgressFor(modalVideoRef.current)
  }

  const handleCanPlay = () => {
    const video = videoRef.current
    if (!video || !playingRef.current || expanded) return
    video.play().catch(() => {})
  }

  const handleInlinePlay = () => {
    if (expanded) return
    onPlaybackChange?.(true)
    reportInlineProgress()
  }

  const handleInlinePause = () => {
    reportInlineProgress()
    if (!expanded) {
      onPlaybackChange?.(false)
    }
  }

  const handleModalPlay = () => {
    onPlaybackChange?.(true)
    reportModalProgress()
  }

  const handleModalPause = () => {
    reportModalProgress()
    if (!closingExpandedRef.current) {
      onPlaybackChange?.(false)
    }
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
  }, [expanded, src])

  useEffect(() => {
    const modalVideo = modalVideoRef.current
    if (!expanded || !modalVideo) return

    if (playing) {
      modalVideo.play().catch(() => {})
    } else {
      modalVideo.pause()
    }
  }, [expanded, playing])

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

  const seekModalFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    const video = modalVideoRef.current
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return

    const rect = event.currentTarget.getBoundingClientRect()
    const nextProgress = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
    const nextTime = video.duration * nextProgress
    video.currentTime = nextTime
    if (videoRef.current) {
      videoRef.current.currentTime = nextTime
    }
    onProgressChange?.(nextProgress)

    if (playingRef.current) {
      video.play().catch(() => {})
    }
  }

  const handleModalSeekPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    modalSeekingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    seekModalFromPointer(event)
  }

  const handleModalSeekPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!modalSeekingRef.current) return
    seekModalFromPointer(event)
  }

  const handleModalSeekPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!modalSeekingRef.current) return
    seekModalFromPointer(event)
    modalSeekingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const closeExpanded = () => {
    const inlineVideo = videoRef.current
    const modalVideo = modalVideoRef.current
    closingExpandedRef.current = true
    if (inlineVideo && modalVideo && Number.isFinite(modalVideo.currentTime)) {
      inlineVideo.currentTime = modalVideo.currentTime
    }
    setExpanded(false)
    window.setTimeout(() => {
      closingExpandedRef.current = false
    }, 0)
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
                controls
                loop
                playsInline
                preload="auto"
                className="relative z-0 h-auto max-h-[82vh] w-full scale-x-[1.035]"
                onCanPlay={handleModalCanPlay}
                onTimeUpdate={reportModalProgress}
                onSeeked={reportModalProgress}
                onPlay={handleModalPlay}
                onPause={handleModalPause}
              >
                <track kind="captions" />
              </video>
              <div
                aria-hidden="true"
                onPointerDown={handleModalSeekPointerDown}
                onPointerMove={handleModalSeekPointerMove}
                onPointerUp={handleModalSeekPointerEnd}
                onPointerCancel={handleModalSeekPointerEnd}
                onClick={(event) => event.stopPropagation()}
                className="absolute inset-x-6 bottom-14 z-10 h-8 cursor-ew-resize rounded-full bg-transparent"
              />
              <div className="absolute top-4 end-4 z-20 flex gap-2">
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
          controls
          loop
          playsInline
          preload="auto"
          className="h-auto w-full scale-x-[1.035]"
          onLoadedMetadata={handleLoadedMetadata}
          onCanPlay={handleCanPlay}
          onTimeUpdate={reportInlineProgress}
          onSeeked={reportInlineProgress}
          onPlay={handleInlinePlay}
          onPause={handleInlinePause}
          onClick={(event) => event.stopPropagation()}
        >
          <track kind="captions" />
        </video>
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
