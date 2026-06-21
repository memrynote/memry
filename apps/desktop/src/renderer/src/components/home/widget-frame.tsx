import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useState, type FC, type ReactNode } from 'react'
import { SIZE_SPANS } from '@/lib/home/widget-sizes'
import type { WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import type { WidgetInstance, WidgetSize } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GripVertical, Settings, X } from '@/lib/icons/icon-map'
import { cn } from '@/lib/utils'

interface WidgetFrameProps {
  widget: WidgetInstance
  title: string
  sizes: WidgetSize[]
  editing: boolean
  onResize: (size: WidgetSize) => void
  onRemove: () => void
  ConfigEditor?: FC<WidgetConfigEditorProps>
  onConfigChange?: (config: Record<string, unknown>) => void
  children: ReactNode
}

export function WidgetFrame({
  widget,
  title,
  sizes,
  editing,
  onResize,
  onRemove,
  ConfigEditor,
  onConfigChange,
  children
}: WidgetFrameProps): React.JSX.Element {
  const { t } = useT('common')
  const [configOpen, setConfigOpen] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: widget.id,
    disabled: !editing
  })
  const span = SIZE_SPANS[widget.size]
  return (
    <div
      ref={setNodeRef}
      data-testid="widget"
      data-widget-type={widget.type}
      data-widget-size={widget.size}
      data-widget-id={widget.id}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        gridColumn: `span ${span.cols}`,
        gridRow: `span ${span.rows}`
      }}
      className="flex flex-col overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3.5 py-2.5 text-xs font-medium text-muted-foreground">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        {editing && (
          <span className="flex items-center gap-1">
            {sizes.map((s) => {
              const active = widget.size === s
              const resizeLabel = t('home.widget.resizeAria', { size: s })
              return (
                <Tooltip key={s}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid={`widget-size-${s}`}
                      aria-label={resizeLabel}
                      aria-pressed={active}
                      onClick={() => onResize(s)}
                      className={cn(
                        'h-7 min-w-7 rounded px-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]',
                        active
                          ? 'bg-[var(--tint-light)] font-semibold text-[var(--tint)]'
                          : 'hover:bg-muted/60'
                      )}
                    >
                      {s}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{resizeLabel}</TooltipContent>
                </Tooltip>
              )
            })}
            {ConfigEditor && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="widget-config-toggle"
                    aria-label={t('home.widget.configAria')}
                    aria-pressed={configOpen}
                    onClick={() => setConfigOpen((open) => !open)}
                    className="text-muted-foreground focus-visible:ring-[var(--tint-ring)]"
                  >
                    <Settings className="size-4" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('home.widget.configAria')}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('home.widget.removeAria')}
                  onClick={onRemove}
                  className="text-muted-foreground focus-visible:ring-[var(--tint-ring)]"
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('home.widget.removeAria')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  {...attributes}
                  {...listeners}
                  aria-label={t('home.widget.dragAria')}
                  className="inline-flex h-8 w-8 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)] active:cursor-grabbing"
                >
                  <GripVertical className="size-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('home.widget.dragAria')}</TooltipContent>
            </Tooltip>
          </span>
        )}
      </div>
      {editing && ConfigEditor && configOpen && (
        <div data-testid="widget-config-panel" className="border-b px-3.5 py-2.5">
          <ConfigEditor config={widget.config} onChange={(c) => onConfigChange?.(c)} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">{children}</div>
    </div>
  )
}
