import { useState, type FC, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { WidgetComponentProps, WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import type { WidgetInstance, WidgetSize } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { MoreVertical } from '@/lib/icons/icon-map'
import { WIDGET_ICONS } from '@/lib/home/widget-icons'

interface WidgetFrameProps {
  widget: WidgetInstance
  // Content-density tier derived from the widget's current grid span (see sizeTier).
  size: WidgetSize
  title: string
  onRemove: () => void
  icon?: string
  // Replaces the static title + icon when present (see WidgetDefinition.Title). `title` is still
  // required: it stays the accessible name of the drag handle, which a custom Title need not carry.
  Title?: FC<WidgetComponentProps>
  ConfigEditor?: FC<WidgetConfigEditorProps>
  HeaderFilter?: FC<WidgetConfigEditorProps>
  HeaderCount?: FC<WidgetComponentProps>
  Footer?: FC<WidgetComponentProps>
  onConfigChange?: (config: Record<string, unknown>) => void
  // The widget body.
  content: ReactNode
}

// Rendered INSIDE the plain wrapper div that react-grid-layout clones (see board-grid). The card
// fills that wrapper; the drag handle is the header, and RGL's resize handle is a sibling appended
// to the wrapper (styled in home-grid.css). Keeping this a normal component — not RGL's cloned
// child — is what keeps drag/resize reliably wired. Pickup elevation (drag/resize lift) is driven
// from home-grid.css off RGL's state classes on the wrapper.
export function WidgetFrame({
  widget,
  size,
  title,
  onRemove,
  icon,
  Title,
  ConfigEditor,
  HeaderFilter,
  HeaderCount,
  Footer,
  onConfigChange,
  content
}: WidgetFrameProps): React.JSX.Element {
  const { t } = useT('common')
  const [configOpen, setConfigOpen] = useState(false)
  const Icon = icon ? WIDGET_ICONS[icon] : undefined
  return (
    <div
      data-testid="widget"
      data-widget-type={widget.type}
      data-widget-size={size}
      data-widget-id={widget.id}
      className={cn(
        'group/widget relative flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-card',
        'shadow-[0_1px_2px_rgba(0,0,0,0.03),0_12px_32px_-24px_rgba(0,0,0,0.16)]'
      )}
    >
      {/* Header is the drag handle (react-grid-layout draggableHandle=".widget-drag-handle").
          Interactive controls carry .widget-no-drag so a click on them doesn't start a drag. */}
      <div
        className="widget-drag-handle flex cursor-grab items-center gap-2 px-3.5 py-2.5"
        aria-label={t('home.widget.dragAria')}
      >
        {Title ? (
          <Title config={widget.config} size={size} />
        ) : (
          <>
            {Icon && <Icon className="size-4 shrink-0 text-[var(--tint)]" aria-hidden="true" />}
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--text-tertiary)]">
              {title}
            </span>
          </>
        )}
        {HeaderFilter && (
          <span className="widget-no-drag">
            <HeaderFilter config={widget.config} onChange={(c) => onConfigChange?.(c)} />
          </span>
        )}
        <span className="grow" />
        {HeaderCount && (
          <span className="widget-no-drag">
            <HeaderCount config={widget.config} size={size} />
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="widget-menu"
              aria-label={t('home.widget.menuAria')}
              className="widget-no-drag inline-flex size-7 shrink-0 items-center justify-center rounded text-[var(--text-tertiary)] transition-[background-color,transform] duration-100 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)] motion-safe:active:scale-90"
            >
              <MoreVertical className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {ConfigEditor && (
              <DropdownMenuItem
                data-testid="widget-config-toggle"
                onSelect={() => setConfigOpen((open) => !open)}
              >
                {t('home.widget.configure')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              {t('home.widget.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {ConfigEditor && configOpen && (
        <div data-testid="widget-config-panel" className="widget-no-drag border-b px-3.5 py-2.5">
          <ConfigEditor config={widget.config} onChange={(c) => onConfigChange?.(c)} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">{content}</div>
      {Footer && <Footer config={widget.config} size={size} />}
    </div>
  )
}
