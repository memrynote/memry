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

// ============================================================================
// Image Viewer Component
// ============================================================================

export function ImageViewer({ src, alt = 'Image', className }: ImageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)

  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  // Reset position when scale changes to 1
  useEffect(() => {
    if (scale === 1) {
      setPosition({ x: 0, y: 0 })
    }
  }, [scale])

  // Attach wheel event with passive: false to allow preventDefault
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheelEvent = (e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.1 : 0.1
      setScale((s) => Math.max(0.25, Math.min(5, s + delta)))
    }

    container.addEventListener('wheel', handleWheelEvent, { passive: false })
    return () => {
      container.removeEventListener('wheel', handleWheelEvent)
    }
  }, [])

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(s + 0.25, 5))
  }, [])

  const zoomOut = useCallback(() => {
    setScale((s) => Math.max(s - 0.25, 0.25))
  }, [])

  const resetZoom = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

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

      setScale(newScale)
      setPosition({ x: 0, y: 0 })
    }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (scale > 1) {
        setIsDragging(true)
        setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
      }
    },
    [scale, position]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        setPosition({
          x: e.clientX - dragStart.x,
          y: e.clientY - dragStart.y
        })
      }
    },
    [isDragging, dragStart]
  )

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

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
          <p className="text-destructive font-medium mb-2">Failed to load image</p>
          <p className="text-sm text-muted-foreground">The image could not be displayed.</p>
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
            title="Reset zoom"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>

          <div className="w-px h-5 bg-border" />

          {/* Rotate */}
          <Button variant="ghost" size="sm" onClick={rotate} className="h-8 w-8 p-0" title="Rotate">
            <RotateCw className="h-4 w-4" />
          </Button>

          {scale > 1 && (
            <>
              <div className="w-px h-5 bg-border" />
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Move className="h-3 w-3" />
                <span>Drag to pan</span>
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
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
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
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`
          }}
          draggable={false}
        />
      </div>
    </div>
  )
}
