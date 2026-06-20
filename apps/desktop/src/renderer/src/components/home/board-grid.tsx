import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { WidgetFrame } from './widget-frame'
import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import { moveWidget, removeWidget, resizeWidget } from '@/lib/home/layout-reducer'
import type { HomePage, WidgetSize } from '@/lib/home/types'

interface BoardGridProps {
  board: HomePage
  onChange: (next: HomePage) => void
  editing: boolean
}

export function BoardGrid({ board, onChange, editing }: BoardGridProps): React.JSX.Element {
  const handleDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) {
      onChange(moveWidget(board, String(e.active.id), String(e.over.id)))
    }
  }
  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={board.widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
        <div
          className="grid auto-rows-[7rem] gap-3"
          style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gridAutoFlow: 'dense' }}
        >
          {board.widgets.map((w) => {
            const def = WIDGET_REGISTRY[w.type]
            if (!def) return null
            const { Component } = def
            return (
              <WidgetFrame
                key={w.id}
                widget={w}
                title={def.titleKey}
                sizes={def.sizes}
                editing={editing}
                onResize={(s: WidgetSize) => onChange(resizeWidget(board, w.id, s))}
                onRemove={() => onChange(removeWidget(board, w.id))}
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
