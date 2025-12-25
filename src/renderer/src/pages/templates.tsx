/**
 * Templates Page
 *
 * Template list and management page.
 * Allows viewing, creating, editing, and deleting templates.
 */

import { useState, useCallback } from 'react'
import { useTabs } from '@/contexts/tabs'
import { useTemplates } from '@/hooks/use-templates'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import { Plus, FileText, Lock, Pencil, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

interface TemplateListItem {
  id: string
  name: string
  description?: string
  icon?: string | null
  isBuiltIn: boolean
}

// ============================================================================
// Main Component
// ============================================================================

export function TemplatesPage() {
  const { templates, isLoading, deleteTemplate } = useTemplates()
  const { openTab } = useTabs()

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [templateToDelete, setTemplateToDelete] = useState<TemplateListItem | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Separate built-in and custom templates
  const builtInTemplates = templates.filter((t) => t.isBuiltIn)
  const customTemplates = templates.filter((t) => !t.isBuiltIn)

  // Handle creating a new template
  const handleNewTemplate = useCallback(() => {
    openTab({
      type: 'template-editor',
      title: 'New Template',
      icon: 'layout-template',
      path: '/templates/new',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }, [openTab])

  // Handle editing a template
  const handleEditTemplate = useCallback(
    (template: TemplateListItem) => {
      openTab({
        type: 'template-editor',
        title: template.name,
        icon: 'layout-template',
        path: `/templates/${template.id}`,
        entityId: template.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  // Handle delete confirmation
  const handleDeleteClick = useCallback((template: TemplateListItem) => {
    setTemplateToDelete(template)
    setDeleteDialogOpen(true)
  }, [])

  // Handle delete confirmation
  const handleDeleteConfirm = useCallback(async () => {
    if (!templateToDelete) return

    setIsDeleting(true)
    try {
      const success = await deleteTemplate(templateToDelete.id)
      if (success) {
        toast.success(`Template "${templateToDelete.name}" deleted`)
      } else {
        toast.error('Failed to delete template')
      }
    } catch (err) {
      console.error('Failed to delete template:', err)
      toast.error('Failed to delete template')
    } finally {
      setIsDeleting(false)
      setDeleteDialogOpen(false)
      setTemplateToDelete(null)
    }
  }, [templateToDelete, deleteTemplate])

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p className="text-sm">Loading templates...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div>
          <h1 className="text-xl font-semibold">Templates</h1>
          <p className="text-sm text-muted-foreground">Manage your note templates</p>
        </div>
        <Button onClick={handleNewTemplate} className="gap-2">
          <Plus className="h-4 w-4" />
          New Template
        </Button>
      </div>

      {/* Template list */}
      <ScrollArea className="flex-1">
        <div className="p-6 space-y-8">
          {/* Built-in templates */}
          {builtInTemplates.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
                Built-in Templates
              </h2>
              <div className="space-y-2">
                {builtInTemplates.map((template) => (
                  <TemplateRow key={template.id} template={template} onEdit={handleEditTemplate} />
                ))}
              </div>
            </div>
          )}

          {/* Custom templates */}
          <div>
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
              My Templates
            </h2>
            {customTemplates.length > 0 ? (
              <div className="space-y-2">
                {customTemplates.map((template) => (
                  <TemplateRow
                    key={template.id}
                    template={template}
                    onEdit={handleEditTemplate}
                    onDelete={handleDeleteClick}
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm">No custom templates yet</p>
                <p className="text-xs opacity-70 mt-1">
                  Create a template to reuse note structures
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 gap-2"
                  onClick={handleNewTemplate}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create Template
                </Button>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{templateToDelete?.name}"? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ============================================================================
// Template Row Component
// ============================================================================

interface TemplateRowProps {
  template: TemplateListItem
  onEdit: (template: TemplateListItem) => void
  onDelete?: (template: TemplateListItem) => void
}

function TemplateRow({ template, onEdit, onDelete }: TemplateRowProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-4 p-4 rounded-lg border bg-card',
        'hover:bg-accent/50 transition-colors'
      )}
    >
      {/* Icon */}
      <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-muted text-lg">
        {template.icon || <FileText className="w-5 h-5 text-muted-foreground" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{template.name}</span>
          {template.isBuiltIn && (
            <Lock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          )}
        </div>
        {template.description && (
          <p className="text-sm text-muted-foreground truncate mt-0.5">{template.description}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(template)}>
          <Pencil className="h-4 w-4" />
          <span className="sr-only">Edit</span>
        </Button>
        {!template.isBuiltIn && onDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive"
            onClick={() => onDelete(template)}
          >
            <Trash2 className="h-4 w-4" />
            <span className="sr-only">Delete</span>
          </Button>
        )}
      </div>
    </div>
  )
}

export default TemplatesPage
