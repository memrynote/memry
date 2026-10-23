import { useCallback, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { ZoomIn, ZoomOut, Maximize2 } from '@/lib/icons'

const MIN_SCALE = 0.25
const MAX_SCALE = 8
const BUTTON_STEP = 1.25

interface Offset {
  x: number
  y: number
}

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

interface ImageLightboxProps {
  /** The rendered image URL. The lightbox only reads it, so the note is never touched. */
  src: string
  alt: string
  onClose: () => void
}

/** Modal image viewer with wheel and button zoom and drag pan. Esc or a click outside the image closes it. */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const { t } = useT('notes')
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: Offset } | null>(
    null
  )

  const reset = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => clampScale(s * factor))
  }, [])

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <DialogPrimitive.Content
          data-testid="image-lightbox"
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden outline-none"
          onClick={(e) => e.target === e.currentTarget && onClose()}
          onWheel={(e) => {
            zoomBy(e.deltaY < 0 ? BUTTON_STEP : 1 / BUTTON_STEP)
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t('editor.imageLightbox.title')}
          </DialogPrimitive.Title>
          <img
            src={src}
            alt={alt}
            draggable={false}
            className="max-h-[90vh] max-w-[90vw] cursor-grab select-none object-contain active:cursor-grabbing"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
            onDoubleClick={reset}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              drag.current = {
                pointerId: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                origin: offset
              }
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d || d.pointerId !== e.pointerId) return
              setOffset({
                x: d.origin.x + e.clientX - d.startX,
                y: d.origin.y + e.clientY - d.startY
              })
            }}
            onPointerUp={() => {
              drag.current = null
            }}
            onPointerCancel={() => {
              drag.current = null
            }}
          />
          <div className="absolute bottom-6 start-1/2 flex -translate-x-1/2 items-center gap-1 rounded-lg bg-background/90 p-1 shadow-lg rtl:translate-x-1/2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('editor.imageLightbox.zoomOut')}
              onClick={() => {
                zoomBy(1 / BUTTON_STEP)
              }}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="min-w-12 text-center text-sm tabular-nums">
              {Math.round(scale * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('editor.imageLightbox.zoomIn')}
              onClick={() => {
                zoomBy(BUTTON_STEP)
              }}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('editor.imageLightbox.reset')}
              onClick={reset}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
