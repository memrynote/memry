/**
 * Image Viewer Component
 * Full-page image viewer with zoom, pan, and rotation controls.
 *
 * @module components/viewers/image-viewer
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { ZoomIn, ZoomOut, RotateCw, Maximize2, Move } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// Types
// ============================================================================

interface ImageViewerProps {
  /** File path or URL to the image */
  src: string
  /** Alt text for the image */
  alt?: string
  /** CSS classes */
  className?: string
}

interface Position {
  x: number
  y: number
}

/** Single source of truth for the image transform, shared by React and the imperative pan writes. */
function buildTransform(position: Position, scale: number, rotation: number): string {
  return `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`
}

// ============================================================================
// Image Viewer Component
// ============================================================================

export function ImageViewer({ src, alt = 'Image', className }: ImageViewerProps) {
  const { t: tPhaseF } = useT('notes')
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)

  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  /** Live pan offset. Leads `position` during a drag; `position` catches up on pointer-up. */
  const positionRef = useRef<Position>(position)
  const dragStartRef = useRef<Position>({ x: 0, y: 0 })
  /** Live scale, so the zoom handlers can compute the next value without a stale closure. */
  const scaleRef = useRef(scale)

  const commitPosition = useCallback((next: Position) => {
    positionRef.current = next
    setPosition(next)
  }, [])

  // Every zoom write goes through here: dropping back to 1x recenters in the same batch as
  // the scale change. Doing it in the render body instead (`if (scale === 1) setPosition(...)`)
  // made React throw the render away and run the component a second time on every zoom-out.
  const applyScale = useCallback(
    (next: number) => {
      scaleRef.current = next
      setScale(next)
      if (next === 1 && (positionRef.current.x !== 0 || positionRef.current.y !== 0)) {
        commitPosition({ x: 0, y: 0 })
      }
    },
    [commitPosition]
  )

  // Attach wheel event with passive: false to allow preventDefault
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheelEvent = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.1 : 0.1
      applyScale(Math.max(0.25, Math.min(5, scaleRef.current + delta)))
    }

    container.addEventListener('wheel', handleWheelEvent, { passive: false })
    return () => {
      container.removeEventListener('wheel', handleWheelEvent)
    }
  }, [applyScale])

  const zoomIn = useCallback(() => {
    applyScale(Math.min(scaleRef.current + 0.25, 5))
  }, [applyScale])

  const zoomOut = useCallback(() => {
    applyScale(Math.max(scaleRef.current - 0.25, 0.25))
  }, [applyScale])

  const resetZoom = useCallback(() => {
    applyScale(1)
    commitPosition({ x: 0, y: 0 })
  }, [applyScale, commitPosition])

  const rotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360)
  }, [])

  const fitToContainer = useCallback(() => {
    if (containerRef.current && imageRef.current) {
      const containerWidth = containerRef.current.clientWidth - 48
      const containerHeight = containerRef.current.clientHeight - 48
      const imageWidth = imageRef.current.naturalWidth
      const imageHeight = imageRef.current.naturalHeight

      const scaleX = containerWidth / imageWidth
      const scaleY = containerHeight / imageHeight
      const newScale = Math.min(scaleX, scaleY, 1)

      applyScale(newScale)
      commitPosition({ x: 0, y: 0 })
    }
  }, [applyScale, commitPosition])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (scale > 1) {
        dragStartRef.current = {
          x: e.clientX - positionRef.current.x,
          y: e.clientY - positionRef.current.y
        }
        setIsDragging(true)
      }
    },
    [scale]
  )

  // Pan writes the transform straight to the DOM so a gesture costs zero React renders.
  // Listeners live on the window so the drag survives leaving the container and still
  // ends on mouseup outside it; `position` is reconciled once the gesture finishes.
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const next = {
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y
      }
      positionRef.current = next
      if (imageRef.current) {
        imageRef.current.style.transform = buildTransform(next, scale, rotation)
      }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      commitPosition(positionRef.current)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, scale, rotation, commitPosition])

  const handleImageLoad = useCallback(() => {
    setLoaded(true)
    setError(false)
    fitToContainer()
  }, [fitToContainer])

  const handleImageError = useCallback(() => {
    setLoaded(false)
    setError(true)
  }, [])

  if (error) {
    return (
      <div
        className={cn('flex h-full items-center justify-center bg-muted/30 rounded-md', className)}
      >
        <div className="text-center p-8">
          <p className="text-destructive font-medium mb-2">
            {tPhaseF('phaseF.componentsViewersImageViewer.failedToLoadImage')}
          </p>
          <p className="text-sm text-muted-foreground">
            {tPhaseF('phaseF.componentsViewersImageViewer.theImageCouldNotBeDisplayed')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex h-full flex-col bg-muted/20 min-h-0', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <Button variant="ghost" size="sm" onClick={zoomOut} className="h-8 w-8 p-0">
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[50px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="ghost" size="sm" onClick={zoomIn} className="h-8 w-8 p-0">
            <ZoomIn className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={resetZoom}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersImageViewer.resetZoom')}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>

          <div className="w-px h-5 bg-border" />

          {/* Rotate */}
          <Button
            variant="ghost"
            size="sm"
            onClick={rotate}
            className="h-8 w-8 p-0"
            title={tPhaseF('phaseF.componentsViewersImageViewer.rotate')}
          >
            <RotateCw className="h-4 w-4" />
          </Button>

          {scale > 1 && (
            <>
              <div className="w-px h-5 bg-border" />
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Move className="h-3 w-3" />
                <span>{tPhaseF('phaseF.componentsViewersImageViewer.dragToPan')}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Image container */}
      <div
        ref={containerRef}
        className={cn(
          'flex-1 overflow-hidden flex items-center justify-center bg-[repeating-conic-gradient(#80808015_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]',
          scale > 1 ? 'cursor-grab' : 'cursor-default',
          isDragging && 'cursor-grabbing'
        )}
        onMouseDown={handleMouseDown}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          onLoad={handleImageLoad}
          onError={handleImageError}
          className={cn(
            'max-w-none transition-transform select-none',
            !loaded && 'opacity-0',
            isDragging && 'transition-none'
          )}
          style={{
            // Live ref, not `position`: a render triggered mid-drag (e.g. wheel zoom) must not
            // rewrite the transform with the stale pointer-down offset.
            transform: buildTransform(positionRef.current, scale, rotation)
          }}
          draggable={false}
        />
      </div>
    </div>
  )
}
