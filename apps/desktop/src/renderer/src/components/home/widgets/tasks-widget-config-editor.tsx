import type React from 'react'
import { useSavedFilters } from '@/hooks/use-task-filters'
import type { WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import { useT } from '@memry/i18n/renderer'

export function TasksWidgetConfigEditor({
  config,
  onChange
}: WidgetConfigEditorProps): React.JSX.Element {
  const { t } = useT('common')
  const { savedFilters } = useSavedFilters()

  const savedFilterId = typeof config.savedFilterId === 'string' ? config.savedFilterId : ''

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {t('home.widget.savedFilterLabel')}
      </span>
      <select
        value={savedFilterId}
        onChange={(e) => onChange({ ...config, savedFilterId: e.target.value || undefined })}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
      >
        <option value="">{t('home.widget.savedFilterDefault')}</option>
        {savedFilters.map((filter) => (
          <option key={filter.id} value={filter.id}>
            {filter.name}
          </option>
        ))}
      </select>
      {savedFilters.length === 0 && (
        <span className="text-xs text-muted-foreground">{t('home.widget.savedFilterHint')}</span>
      )}
    </label>
  )
}
