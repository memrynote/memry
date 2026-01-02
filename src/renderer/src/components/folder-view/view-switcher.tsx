/**
 * View Switcher Component
 *
 * Dropdown-based view selector for folder view with management capabilities.
 * Supports multiple named views, creation, renaming, duplication, and deletion.
 */

import { useState, useCallback } from 'react'
import { Plus, ChevronDown, Pencil, Copy, Star, Trash2, Check, MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
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
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { DEFAULT_COLUMNS } from '@shared/contracts/folder-view-api'
import type { ViewConfig } from '@/hooks/use-folder-view'

// ============================================================================
// Types
// ============================================================================

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
  /** Called when user sets a view as default */
  onSetViewAsDefault: (index: number) => Promise<void>
  /** Called when user deletes a view */
  onDeleteView: (viewName: string) => Promise<void>
  /** Additional CSS classes */
  className?: string
}

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
  onSetViewAsDefault,
  onDeleteView,
  className
}: ViewSwitcherProps): React.JSX.Element {
  // Dropdown open state
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)

  // Dialog states
  const [isNewViewDialogOpen, setIsNewViewDialogOpen] = useState(false)
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [selectedViewForAction, setSelectedViewForAction] = useState<{
    index: number
    view: ViewConfig
  } | null>(null)

  // Form states
  const [newViewName, setNewViewName] = useState('')
  const [copyFromCurrent, setCopyFromCurrent] = useState(true)
  const [renameValue, setRenameValue] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  // ============================================================================
  // Handlers
  // ============================================================================

  /**
   * Handle selecting a view from dropdown
   */
  const handleSelectView = useCallback(
    (index: number) => {
      onViewChange(index)
      setIsDropdownOpen(false)
    },
    [onViewChange]
  )

  /**
   * Handle creating a new view
   */
  const handleCreateView = useCallback(async () => {
    if (!newViewName.trim()) return

    setIsSubmitting(true)
    try {
      const baseConfig: ViewConfig =
        copyFromCurrent && activeView
          ? { ...activeView, name: newViewName.trim(), default: false }
          : {
              name: newViewName.trim(),
              type: 'table',
              columns: DEFAULT_COLUMNS,
              order: [{ property: 'modified', direction: 'desc' }]
            }

      await onAddView(baseConfig)

      setIsNewViewDialogOpen(false)
      setNewViewName('')
      setCopyFromCurrent(true)
    } catch (err) {
      console.error('[ViewSwitcher] Failed to create view:', err)
      // Keep dialog open on error so user can retry
    } finally {
      setIsSubmitting(false)
    }
  }, [newViewName, copyFromCurrent, activeView, onAddView])

  /**
   * Handle renaming a view
   */
  const handleRenameView = useCallback(async () => {
    if (!renameValue.trim() || !selectedViewForAction) return

    // Check for duplicate names
    const nameExists = views.some(
      (v, i) =>
        i !== selectedViewForAction.index &&
        v.name.toLowerCase() === renameValue.trim().toLowerCase()
    )
    if (nameExists) {
      // Could show an error toast here
      return
    }

    setIsSubmitting(true)
    try {
      // First switch to this view if not active
      if (selectedViewForAction.index !== activeViewIndex) {
        onViewChange(selectedViewForAction.index)
      }

      // Update the view name
      await onUpdateView({ name: renameValue.trim() })
      setIsRenameDialogOpen(false)
      setSelectedViewForAction(null)
      setRenameValue('')
    } finally {
      setIsSubmitting(false)
    }
  }, [renameValue, selectedViewForAction, views, activeViewIndex, onViewChange, onUpdateView])

  /**
   * Handle duplicating a view
   */
  const handleDuplicateView = useCallback(
    async (view: ViewConfig) => {
      const baseName = view.name.replace(/\s*\(copy(?:\s*\d+)?\)$/, '')
      let copyNumber = 1
      let newName = `${baseName} (copy)`

      // Find unique name
      while (views.some((v) => v.name.toLowerCase() === newName.toLowerCase())) {
        copyNumber++
        newName = `${baseName} (copy ${copyNumber})`
      }

      await onAddView({
        ...view,
        name: newName,
        default: false
      })
    },
    [views, onAddView]
  )

  /**
   * Handle setting a view as default
   */
  const handleSetDefault = useCallback(
    async (index: number) => {
      await onSetViewAsDefault(index)
    },
    [onSetViewAsDefault]
  )

  /**
   * Handle deleting a view
   */
  const handleDeleteView = useCallback(async () => {
    if (!selectedViewForAction) return

    setIsSubmitting(true)
    try {
      await onDeleteView(selectedViewForAction.view.name)
      setIsDeleteDialogOpen(false)
      setSelectedViewForAction(null)
    } finally {
      setIsSubmitting(false)
    }
  }, [selectedViewForAction, onDeleteView])

  /**
   * Open rename dialog for a view
   */
  const openRenameDialog = useCallback((index: number, view: ViewConfig) => {
    setSelectedViewForAction({ index, view })
    setRenameValue(view.name)
    setIsRenameDialogOpen(true)
    setIsDropdownOpen(false)
  }, [])

  /**
   * Open delete confirmation dialog
   */
  const openDeleteDialog = useCallback((index: number, view: ViewConfig) => {
    setSelectedViewForAction({ index, view })
    setIsDeleteDialogOpen(true)
    setIsDropdownOpen(false)
  }, [])

  /**
   * Open new view dialog
   */
  const openNewViewDialog = useCallback(() => {
    setIsNewViewDialogOpen(true)
    setIsDropdownOpen(false)
  }, [])

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <>
      <DropdownMenu open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
        {/* Trigger Button */}
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={cn('gap-2 h-8', className)}>
            <span className="max-w-[150px] truncate">{activeView?.name ?? 'Select View'}</span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>

        {/* Dropdown Content */}
        <DropdownMenuContent align="end" className="w-64">
          {/* View List */}
          {views.map((view, index) => {
            const isActive = index === activeViewIndex
            const isDefault = view.default === true
            const canDelete = views.length > 1

            return (
              <DropdownMenuSub key={view.name}>
                {/* View Row with Submenu */}
                <div className="flex items-center">
                  {/* Main clickable area - selects the view */}
                  <DropdownMenuItem
                    className="flex-1 pr-0"
                    onSelect={(e) => {
                      e.preventDefault()
                      handleSelectView(index)
                    }}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {/* Checkmark for active view */}
                      {isActive ? (
                        <Check className="h-4 w-4 flex-shrink-0" />
                      ) : (
                        <span className="w-4 flex-shrink-0" />
                      )}

                      {/* View name */}
                      <span className="truncate">{view.name}</span>

                      {/* Default badge */}
                      {isDefault && (
                        <Badge
                          variant="secondary"
                          className="h-5 px-1.5 text-[10px] font-normal flex-shrink-0"
                        >
                          default
                        </Badge>
                      )}
                    </div>
                  </DropdownMenuItem>

                  {/* Actions submenu trigger */}
                  <DropdownMenuSubTrigger className="px-2 py-1.5 ml-0 data-[state=open]:bg-accent">
                    <MoreHorizontal className="h-4 w-4" />
                  </DropdownMenuSubTrigger>
                </div>

                {/* Actions Submenu */}
                <DropdownMenuSubContent sideOffset={2} className="w-44">
                  <DropdownMenuItem onSelect={() => openRenameDialog(index, view)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      handleDuplicateView(view)
                      setIsDropdownOpen(false)
                    }}
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    Duplicate
                  </DropdownMenuItem>
                  {!isDefault && (
                    <DropdownMenuItem
                      onSelect={() => {
                        handleSetDefault(index)
                        setIsDropdownOpen(false)
                      }}
                    >
                      <Star className="mr-2 h-4 w-4" />
                      Set as Default
                    </DropdownMenuItem>
                  )}
                  {canDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => openDeleteDialog(index, view)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })}

          <DropdownMenuSeparator />

          {/* Create New View */}
          <DropdownMenuItem onSelect={openNewViewDialog}>
            <Plus className="mr-2 h-4 w-4" />
            Create New View
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* New View Dialog */}
      <Dialog open={isNewViewDialogOpen} onOpenChange={setIsNewViewDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Create New View</DialogTitle>
            <DialogDescription>
              Create a new view with custom columns, filters, and sorting.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="view-name">View Name</Label>
              <Input
                id="view-name"
                value={newViewName}
                onChange={(e) => setNewViewName(e.target.value)}
                placeholder="My Custom View"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newViewName.trim()) {
                    handleCreateView()
                  }
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label>Base Configuration</Label>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="base-config"
                    checked={copyFromCurrent}
                    onChange={() => setCopyFromCurrent(true)}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">Copy from current view</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="base-config"
                    checked={!copyFromCurrent}
                    onChange={() => setCopyFromCurrent(false)}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">Start fresh (default columns)</span>
                </label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsNewViewDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateView} disabled={!newViewName.trim() || isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename View Dialog */}
      <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Rename View</DialogTitle>
            <DialogDescription>Enter a new name for this view.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="rename-view">View Name</Label>
              <Input
                id="rename-view"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="View name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renameValue.trim()) {
                    handleRenameView()
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRenameView} disabled={!renameValue.trim() || isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete View</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{selectedViewForAction?.view.name}"? This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteView}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSubmitting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export default ViewSwitcher
