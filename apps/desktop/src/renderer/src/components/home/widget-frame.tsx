import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'
import { SIZE_SPANS } from '@/lib/home/widget-sizes'
import type { WidgetInstance, WidgetSize } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'

interface WidgetFrameProps {
  widget: WidgetInstance
  title: string
  sizes: WidgetSize[]
  editing: boolean
  onResize: (size: WidgetSize) => void
  onRemove: () => void
  children: ReactNode
}

export function WidgetFrame({
  widget,
  title,
  sizes,
  editing,
  onResize,
  onRemove,
  children
}: WidgetFrameProps): React.JSX.Element {
  const { t } = useT('common')
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: widget.id,
    disabled: !editing
  })
  const span = SIZE_SPANS[widget.size]
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        gridColumn: `span ${span.cols}`,
        gridRow: `span ${span.rows}`
      }}
      className="flex flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <span className="truncate">{title}</span>
        {editing && (
          <span className="flex items-center gap-1">
            {sizes.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onResize(s)}
                className={widget.size === s ? 'font-semibold text-foreground' : ''}
              >
                {s}
              </button>
            ))}
            <button type="button" aria-label={t('home.widget.removeAria')} onClick={onRemove}>
              ×
            </button>
            <span
              {...attributes}
              {...listeners}
              aria-label={t('home.widget.dragAria')}
              className="cursor-grab"
            >
              ⠿
            </span>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </div>
  )
}
