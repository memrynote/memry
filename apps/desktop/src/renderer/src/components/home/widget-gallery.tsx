import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import type { WidgetType } from '@/lib/home/types'

interface WidgetGalleryProps {
  onAdd: (type: WidgetType) => void
}

export function WidgetGallery({ onAdd }: WidgetGalleryProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      {Object.values(WIDGET_REGISTRY).map((def) => (
        <button key={def.type} type="button" onClick={() => onAdd(def.type)} className="text-start">
          {def.titleKey}
        </button>
      ))}
    </div>
  )
}
