import type React from 'react'
import { useNoteFoldersQuery } from '@/hooks/use-notes-query'
import { useFolderView } from '@/hooks/use-folder-view'
import type { WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import { ChevronDown, Folder, Check } from '@/lib/icons/icon-map'
import { getViewDisplayName } from '@/lib/contract-display-names'
import { useT } from '@memry/i18n/renderer'

// Last path segment — compact label for nested folders ("Work/Specs" → "Specs").
const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

// Folder picker + saved-view switcher live on one line in the widget header, so changing either is
// a single click. Saved views come from the folder's .folder.md config (same source as the full
// Folder page); selecting one stores its name in config.viewName and its type (table/grid/list)
// drives how the widget body renders.
export function FolderHeaderControls({
  config,
  onChange
}: WidgetConfigEditorProps): React.JSX.Element {
  const { t } = useT('common')
  const { folders } = useNoteFoldersQuery()
  const folderPath = typeof config.folderPath === 'string' ? config.folderPath : ''
  const viewName = typeof config.viewName === 'string' ? config.viewName : undefined
  const { views, activeView } = useFolderView({ scope: { kind: 'folder', path: folderPath } })
  const currentViewName = viewName ?? activeView?.name

  return (
    <span className="flex min-w-0 items-center gap-1">
      {/* ponytail: defaultOpen pops the menu on mount when unconfigured — covers the just-added
          widget without cross-component wiring. An unconfigured widget also reopens on revisit,
          which is harmless (it has nothing to show anyway). */}
      <DropdownMenu defaultOpen={folderPath === ''}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="folder-widget-picker"
            className="inline-flex h-[22px] min-w-0 max-w-[140px] shrink items-center gap-1 rounded-full border border-[var(--tint-border)] bg-[var(--tint-light)] px-2 text-[11px] font-semibold text-[var(--tint)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
          >
            <Folder className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {folderPath ? basename(folderPath) : t('home.widget.folderPickPrompt')}
            </span>
            <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          {folders.length === 0 ? (
            <DropdownMenuItem disabled>{t('home.widget.folderEmpty')}</DropdownMenuItem>
          ) : (
            folders.map((folder) => (
              <DropdownMenuItem
                key={folder.path}
                // Switching folders drops the saved-view selection — viewName belongs to the
                // previous folder and would not exist in the new one.
                onSelect={() =>
                  onChange({ ...config, folderPath: folder.path, viewName: undefined })
                }
                className="gap-2"
              >
                <Folder
                  className="size-3.5 shrink-0 text-[var(--text-tertiary)]"
                  aria-hidden="true"
                />
                <span className="truncate">{folder.path}</span>
                {folder.path === folderPath && (
                  <Check
                    className="ms-auto size-3.5 shrink-0 text-[var(--tint)]"
                    aria-hidden="true"
                  />
                )}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Saved-view switcher only matters once there's a folder with views to render. */}
      {folderPath && views.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="folder-widget-view-picker"
              aria-label={t('home.widget.folderViewSelect')}
              className="inline-flex h-[22px] min-w-0 max-w-[120px] shrink items-center gap-1 rounded-full border border-[var(--border)] bg-card px-2 text-[11px] font-semibold text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]"
            >
              <span className="truncate">
                {currentViewName
                  ? getViewDisplayName(currentViewName)
                  : t('home.widget.folderViewSelect')}
              </span>
              <ChevronDown
                className="size-3 shrink-0 text-[var(--text-tertiary)]"
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {views.map((view) => (
              <DropdownMenuItem
                key={view.name}
                onSelect={() => onChange({ ...config, viewName: view.name })}
                className="gap-2"
              >
                <span className="truncate">{getViewDisplayName(view.name)}</span>
                {view.name === currentViewName && (
                  <Check
                    className="ms-auto size-3.5 shrink-0 text-[var(--tint)]"
                    aria-hidden="true"
                  />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </span>
  )
}
