import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import type { WidgetType } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'

interface WidgetGalleryProps {
  onAdd: (type: WidgetType) => void
}

export function WidgetGallery({ onAdd }: WidgetGalleryProps): React.JSX.Element {
  const { t } = useT('common')
  return (
    <div data-testid="widget-gallery" className="flex flex-col gap-1">
      {Object.values(WIDGET_REGISTRY).map((def) => (
        <button
          key={def.type}
          type="button"
          data-testid="widget-gallery-item"
          data-widget-type={def.type}
          onClick={() => onAdd(def.type)}
          className="rounded-md px-2 py-1 text-start text-sm hover:bg-muted/60"
        >
          {t(def.titleKey)}
        </button>
      ))}
    </div>
  )
}
