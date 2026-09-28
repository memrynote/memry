/**
 * Saved graph views: switch between named filter + colour + collapse +
 * layout sets, save the current one, update or delete a saved one.
 */

import { useState } from 'react'
import { Check, ChevronDown, Layers, Plus, Save, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useT } from '@memry/i18n/renderer'
import type { SavedGraphView } from '@memry/contracts/graph-api'

interface GraphViewsMenuProps {
  views: SavedGraphView[]
  activeView: SavedGraphView | null
  /** The current state differs from the active saved view's. */
  isModified: boolean
  onApply: (view: SavedGraphView) => void
  /** Returns false when the view could not be saved (empty name, list full). */
  onSaveAs: (name: string) => boolean
  onUpdate: (view: SavedGraphView) => void
  onDelete: (view: SavedGraphView) => void
}

export function GraphViewsMenu({
  views,
  activeView,
  isModified,
  onApply,
  onSaveAs,
  onUpdate,
  onDelete
}: GraphViewsMenuProps): React.JSX.Element {
  const { t } = useT('graph')
  const [saveOpen, setSaveOpen] = useState(false)
  const [name, setName] = useState('')

  const handleSave = (): void => {
    if (onSaveAs(name)) {
      setSaveOpen(false)
      setName('')
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full justify-start gap-2 px-2.5 text-xs"
            data-testid="graph-views-trigger"
          >
            <Layers className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-start">
              {activeView ? activeView.name : t('views.unsaved')}
            </span>
            {activeView && isModified && (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t('views.edited')}
              </span>
            )}
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>{t('views.title')}</DropdownMenuLabel>
          {views.length === 0 && (
            <p className="px-2 pb-1.5 text-[11px] text-muted-foreground">{t('views.empty')}</p>
          )}
          {views.map((view) => (
            <DropdownMenuItem
              key={view.id}
              onSelect={() => onApply(view)}
              className="flex items-center gap-2"
            >
              <Check
                className={cn(
                  'size-3 shrink-0',
                  view.id === activeView?.id ? 'opacity-100' : 'opacity-0'
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[12px]">{view.name}</span>
              <button
                type="button"
                aria-label={t('views.delete', { name: view.name })}
                title={t('views.delete', { name: view.name })}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onDelete(view)
                }}
                className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-3" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {activeView && isModified && (
            <DropdownMenuItem onSelect={() => onUpdate(activeView)} className="gap-2">
              <Save className="size-3 shrink-0" />
              <span className="min-w-0 truncate text-[12px]">
                {t('views.update', { name: activeView.name })}
              </span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => setSaveOpen(true)}
            className="gap-2"
            data-testid="graph-views-save-as"
          >
            <Plus className="size-3 shrink-0" />
            <span className="text-[12px]">{t('views.save-as')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('views.save-dialog-title')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleSave()
              }
            }}
            placeholder={t('views.save-dialog-placeholder')}
            aria-label={t('views.save-dialog-title')}
            data-testid="graph-views-save-name"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              {t('views.cancel')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={name.trim() === ''}
              data-testid="graph-views-save-confirm"
            >
              {t('views.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
