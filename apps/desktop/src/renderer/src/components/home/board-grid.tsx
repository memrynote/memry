import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates
} from '@dnd-kit/sortable'
import { WidgetFrame } from './widget-frame'
import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import {
  moveWidget,
  removeWidget,
  resizeWidget,
  updateWidgetConfig
} from '@/lib/home/layout-reducer'
import type { HomePage, WidgetSize } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'

interface BoardGridProps {
  board: HomePage
  onChange: (next: HomePage) => void
}

export function BoardGrid({ board, onChange }: BoardGridProps): React.JSX.Element {
  const { t } = useT('common')
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const handleDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) {
      onChange(moveWidget(board, String(e.active.id), String(e.over.id)))
    }
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={board.widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
        <div
          data-testid="board-grid"
          className="grid auto-rows-[7rem] gap-3"
          style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gridAutoFlow: 'dense' }}
        >
          {board.widgets.map((w) => {
            const def = WIDGET_REGISTRY[w.type]
            if (!def) {
              return (
                <WidgetFrame
                  key={w.id}
                  widget={w}
                  title={t('home.widget.unknown')}
                  sizes={[]}
                  onResize={(s: WidgetSize) => onChange(resizeWidget(board, w.id, s))}
                  onRemove={() => onChange(removeWidget(board, w.id))}
                >
                  <p data-testid="widget-unknown" className="text-sm text-muted-foreground">
                    {t('home.widget.unknown')}
                  </p>
                </WidgetFrame>
              )
            }
            const { Component } = def
            return (
              <WidgetFrame
                key={w.id}
                widget={w}
                title={t(def.titleKey)}
                sizes={def.sizes}
                onResize={(s: WidgetSize) => onChange(resizeWidget(board, w.id, s))}
                onRemove={() => onChange(removeWidget(board, w.id))}
                ConfigEditor={def.ConfigEditor}
                onConfigChange={(cfg) => onChange(updateWidgetConfig(board, w.id, cfg))}
              >
                <Component config={w.config} size={w.size} />
              </WidgetFrame>
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )
}
