import { useEffect, useState } from 'react'
import type { CanvasSummary } from '@memry/contracts/canvas-api'
import { useT } from '@memry/i18n/renderer'
import { Picker, usePickerContext, usePickerSearch } from '@/components/ui/picker'
import { PenTool } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { canvasService } from '@/services/canvas-service'

export interface CanvasOption {
  id: string
  title: string
}

function CanvasList({ canvases }: { canvases: CanvasOption[] | null }): React.JSX.Element {
  const { t } = useT('notes')
  const { searchQuery } = usePickerContext()
  const filtered = usePickerSearch(canvases ?? [], ['title'], searchQuery)

  if (canvases === null) return <Picker.Empty message={t('similarNotes.canvasLoading')} />
  if (filtered.length === 0) {
    return (
      <Picker.Empty
        message={canvases.length === 0 ? t('similarNotes.noCanvases') : t('similarNotes.noMatch')}
      />
    )
  }
  return (
    <Picker.List>
      {filtered.map((canvas) => (
        <Picker.Item
          key={canvas.id}
          value={canvas.id}
          label={canvas.title}
          icon={<PenTool className="size-3.5 text-text-tertiary" />}
        />
      ))}
    </Picker.List>
  )
}

/** Free-standing, readable canvases; boards owned by a note live inside that note. */
function toOptions(canvases: CanvasSummary[], untitled: string): CanvasOption[] {
  return canvases
    .filter((canvas) => !canvas.unreadable && canvas.ownerNoteId === null)
    .map((canvas) => ({ id: canvas.id, title: canvas.title?.trim() || untitled }))
    .sort((a, b) => a.title.localeCompare(b.title))
}

export function AddToCanvasPicker({
  noteTitle,
  onPick
}: {
  noteTitle: string
  onPick: (canvas: CanvasOption) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const [open, setOpen] = useState(false)
  const [canvases, setCanvases] = useState<CanvasOption[] | null>(null)

  // Listed on open, not on mount: every similar-note row carries a picker.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    canvasService
      .list()
      .then((result) => {
        if (!cancelled) setCanvases(toOptions(result.canvases, tCommon('canvas.untitled')))
      })
      .catch(() => {
        if (!cancelled) setCanvases([])
      })
    return () => {
      cancelled = true
    }
  }, [open, tCommon])

  return (
    <Picker
      open={open}
      onOpenChange={setOpen}
      value={null}
      onValueChange={(id) => {
        const canvas = canvases?.find((option) => option.id === id)
        if (canvas) onPick(canvas)
      }}
    >
      <Picker.Trigger asChild>
        <button
          type="button"
          aria-label={t('similarNotes.addToCanvasAria', { title: noteTitle })}
          title={t('similarNotes.addToCanvas')}
          className={cn(
            'flex size-6 items-center justify-center rounded text-text-tertiary',
            'hover:bg-surface-active/60 hover:text-foreground transition-colors',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
          )}
        >
          <PenTool className="size-3.5" aria-hidden="true" />
        </button>
      </Picker.Trigger>
      <Picker.Content width={240} align="end">
        <Picker.Search placeholder={t('similarNotes.searchCanvases')} />
        <CanvasList canvases={canvases} />
      </Picker.Content>
    </Picker>
  )
}
