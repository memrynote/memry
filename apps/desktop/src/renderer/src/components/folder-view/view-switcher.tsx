import { getI18n } from 'react-i18next'
/**
 * View Switcher Component
 *
 * Popover-based view selector for folder view with management capabilities.
 * Two screens: a saved-views list and a Paper-style view editor (name + layout).
 * The editor is fully live — every change is persisted as it is made, so there
 * is no Save button. Creating a new view creates it immediately and drops into
 * the same live editor.
 */

import { useState, useCallback } from 'react'
import {
  Plus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Star,
  Trash2,
  Check,
  Rows2,
  List,
  LayoutGrid
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { getViewDisplayName } from '@/lib/contract-display-names'
import { DEFAULT_COLUMNS } from '@memry/contracts/folder-view-api'
import type { ViewConfig } from '@/hooks/use-folder-view'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Component:ViewSwitcher')

// ============================================================================
// Types
// ============================================================================

type ViewType = ViewConfig['type']

interface ViewSwitcherProps {
  /** All views for this folder */
  views: ViewConfig[]
  /** Currently active view index */
  activeViewIndex: number
  /** Currently active view config */
  activeView: ViewConfig | null
  /** Called when user switches to a different view */
  onViewChange: (index: number) => void
  /** Called when user creates a new view */
  onAddView: (view: ViewConfig) => Promise<void>
  /** Called when user updates a view */
  onUpdateView: (view: Partial<ViewConfig>) => Promise<void>
  /** Called when user renames a view in place by index */
  onRenameView: (index: number, newName: string) => Promise<void>
  /** Called when user sets a view as default */
  onSetViewAsDefault: (index: number) => Promise<void>
  /** Called when user deletes a view */
  onDeleteView: (viewName: string) => Promise<void>
  /** Additional CSS classes */
  className?: string
}

const LAYOUT_OPTIONS: { type: ViewType; icon: typeof Rows2; labelKey: string }[] = [
  { type: 'table', icon: Rows2, labelKey: 'phaseF.componentsFolderViewViewSwitcher.table' },
  { type: 'list', icon: List, labelKey: 'phaseF.componentsFolderViewViewSwitcher.list' },
  { type: 'grid', icon: LayoutGrid, labelKey: 'phaseF.componentsFolderViewViewSwitcher.gallery' }
]

// ============================================================================
// ViewSwitcher Component
// ============================================================================

export function ViewSwitcher({
  views,
  activeViewIndex,
  activeView,
  onViewChange,
  onAddView,
  onUpdateView,
  onRenameView,
  onSetViewAsDefault,
  onDeleteView,
  className
}: ViewSwitcherProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')

  // Popover + screen state
  const [isOpen, setIsOpen] = useState(false)
  const [screen, setScreen] = useState<'list' | 'editor'>('list')

  // Editor targets a view by index (stable across in-place renames while open)
  const [editorIndex, setEditorIndex] = useState(-1)
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<ViewType>('table')
  const [isDeleting, setIsDeleting] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [deleteTargetName, setDeleteTargetName] = useState<string | null>(null)

  const editingView = editorIndex >= 0 && editorIndex < views.length ? views[editorIndex] : null

  // ============================================================================
  // Helpers
  // ============================================================================

  const makeUniqueName = useCallback(
    (base: string) => {
      let name = base
      let n = 1
      while (views.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
        n++
        name = `${base} ${n}`
      }
      return name
    },
    [views]
  )

  const resetEditor = useCallback(() => {
    setScreen('list')
    setEditorIndex(-1)
    setFormName('')
  }, [])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open)
      if (!open) resetEditor()
    },
    [resetEditor]
  )

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleSelectView = useCallback(
    (index: number) => {
      onViewChange(index)
      setIsOpen(false)
    },
    [onViewChange]
  )

  /**
   * Open the editor for an existing view. Switch to it immediately so that live
   * layout edits (which mutate the active view) target this view.
   */
  const openEdit = useCallback(
    (index: number) => {
      const view = views[index]
      if (!view) return
      if (index !== activeViewIndex) onViewChange(index)
      setEditorIndex(index)
      setFormName(view.name)
      setFormType(view.type)
      setScreen('editor')
    },
    [views, activeViewIndex, onViewChange]
  )

  /**
   * Create a new view immediately (copying the current view's config), then
   * drop into the live editor on it. No separate create form / Save button.
   */
  const handleCreateNew = useCallback(async () => {
    const name = makeUniqueName(tPhaseF('phaseF.componentsFolderViewViewSwitcher.newView'))
    const baseConfig: ViewConfig = activeView
      ? { ...activeView, name, default: false }
      : {
          name,
          type: 'table',
          columns: DEFAULT_COLUMNS,
          order: [{ property: 'modified', direction: 'desc' }]
        }
    // setView appends, so the new view lands at the current end of the list.
    const newIndex = views.length
    try {
      await onAddView(baseConfig)
      setEditorIndex(newIndex)
      setFormName(name)
      setFormType(baseConfig.type)
      setScreen('editor')
    } catch (err) {
      log.error('Failed to create view', err)
      toast.error(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToCreateView')
        )
      )
    }
  }, [makeUniqueName, activeView, onAddView, tPhaseF, views])

  /**
   * Persist the name on every keystroke. `onRenameView` updates the cache
   * immediately and debounces the disk write; it skips empty/duplicate names.
   */
  const handleNameChange = useCallback(
    (value: string) => {
      setFormName(value)
      if (editorIndex >= 0) void onRenameView(editorIndex, value)
    },
    [editorIndex, onRenameView]
  )

  /**
   * On blur, reconcile the field to the persisted name so any unsaved empty or
   * duplicate trailing text is discarded.
   */
  const handleNameBlur = useCallback(() => {
    if (editingView) setFormName(editingView.name)
  }, [editingView])

  /**
   * Apply a layout change live to the (active) edited view.
   */
  const handleLayoutChange = useCallback(
    (type: ViewType) => {
      if (!editingView) return
      setFormType(type)
      void onUpdateView({ type })
    },
    [editingView, onUpdateView]
  )

  const duplicateView = useCallback(
    async (view: ViewConfig | null) => {
      if (!view) return
      const baseName = view.name.replace(/\s*\(copy(?:\s*\d+)?\)$/, '')
      let copyNumber = 1
      let newName = `${baseName} (copy)`
      while (views.some((v) => v.name.toLowerCase() === newName.toLowerCase())) {
        copyNumber++
        newName = `${baseName} (copy ${copyNumber})`
      }
      await onAddView({ ...view, name: newName, default: false })
      setIsOpen(false)
      resetEditor()
    },
    [views, onAddView, resetEditor]
  )

  const requestDelete = useCallback((name: string) => {
    setDeleteTargetName(name)
    setIsDeleteDialogOpen(true)
  }, [])

  const handleSetDefault = useCallback(async () => {
    if (editorIndex < 0) return
    await onSetViewAsDefault(editorIndex)
    setIsOpen(false)
    resetEditor()
  }, [editorIndex, onSetViewAsDefault, resetEditor])

  const handleDeleteView = useCallback(async () => {
    if (!deleteTargetName) return
    setIsDeleting(true)
    try {
      await onDeleteView(deleteTargetName)
      setIsDeleteDialogOpen(false)
      setIsOpen(false)
      resetEditor()
    } finally {
      setIsDeleting(false)
    }
  }, [deleteTargetName, onDeleteView, resetEditor])

  // ============================================================================
  // Render
  // ============================================================================

  const canDelete = views.length > 1

  return (
    <>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className={cn('gap-2 h-8', className)}>
            <span className="max-w-[150px] truncate">
              {activeView ? getViewDisplayName(activeView.name) : tPhaseF('folderView.selectView')}
            </span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-72 p-0">
          {screen === 'list' ? (
            <div className="flex flex-col p-1.5">
              {views.map((view, index) => {
                const isActive = index === activeViewIndex
                const isDefault = view.default === true
                return (
                  <div
                    key={view.name}
                    className={cn(
                      'group flex items-center gap-1 rounded-md',
                      isActive ? 'bg-accent' : 'hover:bg-accent'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectView(index)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-start"
                    >
                      {isActive ? (
                        <Check
                          className="h-3.5 w-3.5 flex-shrink-0 text-[var(--tint)]"
                          strokeWidth={2.5}
                        />
                      ) : (
                        <span className="w-3.5 flex-shrink-0" />
                      )}
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {getViewDisplayName(view.name)}
                      </span>
                      {isDefault && (
                        <span className="flex-shrink-0 rounded-sm bg-[var(--tint)]/15 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-[var(--tint)]">
                          {tPhaseF('phaseF.componentsFolderViewViewSwitcher.default')}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(index)}
                      aria-label={tPhaseF('phaseF.componentsFolderViewViewSwitcher.viewActions')}
                      className="me-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                )
              })}

              <div className="mx-1 my-1 h-px bg-border" />

              <button
                type="button"
                onClick={() => void handleCreateNew()}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-[13px] text-foreground hover:bg-accent"
              >
                <Plus className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                {tPhaseF('phaseF.componentsFolderViewViewSwitcher.newView')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-3.5">
              {/* Header */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setScreen('list')}
                  aria-label={tPhaseF('phaseF.componentsFolderViewViewSwitcher.cancel')}
                  className="-ms-1 flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="truncate text-[13px] font-semibold">{formName}</span>
              </div>

              {/* Name */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {tPhaseF('phaseF.componentsFolderViewViewSwitcher.name')}
                </span>
                <Input
                  autoFocus
                  value={formName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onBlur={handleNameBlur}
                  placeholder={tPhaseF('phaseF.componentsFolderViewViewSwitcher.myCustomView')}
                  className="h-8 text-[13px]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                />
              </div>

              {/* Layout */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {tPhaseF('phaseF.componentsFolderViewViewSwitcher.layout')}
                </span>
                <div className="flex gap-2">
                  {LAYOUT_OPTIONS.map((opt) => {
                    const Icon = opt.icon
                    const selected = formType === opt.type
                    return (
                      <button
                        key={opt.type}
                        type="button"
                        onClick={() => handleLayoutChange(opt.type)}
                        aria-pressed={selected}
                        className={cn(
                          'flex flex-1 flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 transition-colors',
                          selected
                            ? 'border-[var(--tint)] bg-[var(--tint)]/10 text-[var(--tint)]'
                            : 'border-border bg-background text-muted-foreground hover:bg-accent'
                        )}
                      >
                        <Icon className="h-[18px] w-[18px]" />
                        <span className="text-xs font-medium">{tPhaseF(opt.labelKey)}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Secondary actions */}
              <div className="h-px w-full bg-border" />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px]">
                <button
                  type="button"
                  onClick={() => void duplicateView(editingView)}
                  className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {tPhaseF('phaseF.componentsFolderViewViewSwitcher.duplicate')}
                </button>
                {!editingView?.default && (
                  <button
                    type="button"
                    onClick={() => void handleSetDefault()}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
                  >
                    <Star className="h-3.5 w-3.5" />
                    {tPhaseF('phaseF.componentsFolderViewViewSwitcher.setAsDefault')}
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    onClick={() => editingView && requestDelete(editingView.name)}
                    className="flex items-center gap-1.5 text-destructive hover:text-destructive/80"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {tPhaseF('phaseF.componentsFolderViewViewSwitcher.delete')}
                  </button>
                )}
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tPhaseF('phaseF.componentsFolderViewViewSwitcher.deleteView')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tPhaseF('phaseF.componentsFolderViewViewSwitcher.areYouSureYouWantToDelete')}
              {deleteTargetName}"?{' '}
              {tPhaseF('phaseF.componentsFolderViewViewSwitcher.thisActionCannotBeUndone')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {tPhaseF('phaseF.componentsFolderViewViewSwitcher.cancel3')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDeleteView()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default ViewSwitcher
