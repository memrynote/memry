import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import { WIDGET_ICONS } from '@/lib/home/widget-icons'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { WidgetType } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'

interface WidgetGalleryProps {
  onAdd: (type: WidgetType) => void
}

// Renders the widget list as menu items. Must be mounted inside a DropdownMenuContent
// (the Add-widget menu in home-header) — the content owns the `widget-gallery` testid.
export function WidgetGallery({ onAdd }: WidgetGalleryProps): React.JSX.Element {
  const { t } = useT('common')
  return (
    <>
      {Object.values(WIDGET_REGISTRY).map((def) => {
        const Icon = WIDGET_ICONS[def.icon]
        return (
          <DropdownMenuItem
            key={def.type}
            data-testid="widget-gallery-item"
            data-widget-type={def.type}
            onSelect={() => onAdd(def.type)}
          >
            {Icon && <Icon className="size-4 shrink-0 text-text-tertiary" aria-hidden="true" />}
            {t(def.titleKey)}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}
