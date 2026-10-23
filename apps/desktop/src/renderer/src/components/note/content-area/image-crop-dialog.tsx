/**
 * Crop dialog for an image block (#3170).
 *
 * Shows the full picture and a crop rectangle over it. Dragging outside the
 * rectangle draws a new one; dragging inside moves it. Applying hands back a
 * rectangle in percent of the picture (or null to show all of it); the host
 * writes that into the block. The attachment itself is never changed.
 */

import { useRef, useState } from 'react'
import { normalizeImageCrop, type ImageCrop } from '@memry/editor-schema/blocks'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useT } from '@memry/i18n/renderer'

const FULL: ImageCrop = { x: 0, y: 0, w: 100, h: 100 }

type Drag =
  | { kind: 'draw'; startX: number; startY: number }
  | { kind: 'move'; startX: number; startY: number; origin: ImageCrop }

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

export function ImageCropDialog({
  src,
  name,
  crop,
  onOpenChange,
  onApply
}: {
  /** Resolved URL of the full picture. */
  src: string
  name: string
  crop: ImageCrop | null
  onOpenChange: (open: boolean) => void
  onApply: (crop: ImageCrop | null) => void
}) {
  const { t } = useT('notes')
  const [rect, setRect] = useState<ImageCrop>(crop ?? FULL)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)

  // Pointer position as percent of the picture, clamped to it.
  const pointAt = (event: React.PointerEvent): { x: number; y: number } => {
    const box = stageRef.current!.getBoundingClientRect()
    return {
      x: clamp(((event.clientX - box.left) / box.width) * 100, 0, 100),
      y: clamp(((event.clientY - box.top) / box.height) * 100, 0, 100)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const { x, y } = pointAt(event)
    const inside = x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
    const isFull = rect.w === 100 && rect.h === 100
    dragRef.current =
      inside && !isFull
        ? { kind: 'move', startX: x, startY: y, origin: rect }
        : { kind: 'draw', startX: x, startY: y }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag) return
    const { x, y } = pointAt(event)
    if (drag.kind === 'draw') {
      setRect({
        x: Math.min(drag.startX, x),
        y: Math.min(drag.startY, y),
        w: Math.abs(x - drag.startX),
        h: Math.abs(y - drag.startY)
      })
      return
    }
    const { origin } = drag
    setRect({
      ...origin,
      x: clamp(origin.x + x - drag.startX, 0, 100 - origin.w),
      y: clamp(origin.y + y - drag.startY, 0, 100 - origin.h)
    })
  }

  const handlePointerUp = (): void => {
    const drag = dragRef.current
    dragRef.current = null
    // A click without a drag draws nothing; keep the last real rectangle.
    if (drag?.kind === 'draw' && !normalizeImageCrop(rect)) setRect(crop ?? FULL)
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="image-crop-dialog">
        <DialogHeader>
          <DialogTitle>{t('editor.imageCrop.title')}</DialogTitle>
          <DialogDescription>{t('editor.imageCrop.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-center">
          <div
            ref={stageRef}
            data-testid="image-crop-stage"
            className="relative cursor-crosshair touch-none select-none overflow-hidden"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            <img src={src} alt={name} draggable={false} className="block max-h-[60vh] max-w-full" />
            <div
              data-testid="image-crop-selection"
              className="pointer-events-none absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
              // Picture coordinates, not text direction: a crop names the same
              // pixels in a right-to-left note.
              style={{
                left: `${rect.x}%`,
                top: `${rect.y}%`,
                width: `${rect.w}%`,
                height: `${rect.h}%`
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRect(FULL)}>
            {t('editor.imageCrop.reset')}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('editor.imageCrop.cancel')}
          </Button>
          <Button onClick={() => onApply(normalizeImageCrop(rect))}>
            {t('editor.imageCrop.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
