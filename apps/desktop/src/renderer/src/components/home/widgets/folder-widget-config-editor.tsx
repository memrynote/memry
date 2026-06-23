import type React from 'react'
import { useNoteFoldersQuery } from '@/hooks/use-notes-query'
import type { WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

type FolderViewType = 'list' | 'board' | 'gallery'

const VIEW_TYPES: FolderViewType[] = ['list', 'board', 'gallery']

export function FolderWidgetConfigEditor({
  config,
  onChange
}: WidgetConfigEditorProps): React.JSX.Element {
  const { t } = useT('common')
  const { folders } = useNoteFoldersQuery()

  const folderPath = typeof config.folderPath === 'string' ? config.folderPath : ''
  const viewType = (config.viewType as FolderViewType) ?? 'list'

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t('home.widget.folder')}</span>
        <select
          value={folderPath}
          onChange={(e) => onChange({ ...config, folderPath: e.target.value })}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        >
          <option value="">{t('home.widget.folderPickPrompt')}</option>
          {folders.map((folder) => (
            <option key={folder.path} value={folder.path}>
              {folder.path}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t('home.widget.folderViewLabel')}
        </span>
        <div className="flex gap-1">
          {VIEW_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => onChange({ ...config, viewType: type })}
              className={cn(
                'flex-1 rounded-md border px-2 py-1 text-xs capitalize transition-colors',
                viewType === type
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-input text-muted-foreground hover:bg-muted/60'
              )}
            >
              {t(`home.widget.folderView_${type}`)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
