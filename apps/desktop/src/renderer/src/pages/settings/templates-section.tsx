import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { FileText, Plus, MoreHorizontal, Pencil, Copy, Trash2, Lock } from '@/lib/icons'
import { useTemplates } from '@/hooks/use-templates'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'

export function TemplatesSettings() {
  const { templates, isLoading, deleteTemplate, duplicateTemplate } = useTemplates()
  const { openTab } = useTabs()
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [duplicateName, setDuplicateName] = useState('')
  const [duplicateId, setDuplicateId] = useState<string | null>(null)

  const handleCreateTemplate = useCallback(() => {
    openTab({
      type: 'template-editor',
      title: 'New Template',
      icon: 'file-text',
      path: '/templates/new',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }, [openTab])

  const handleEditTemplate = useCallback(
    (id: string, name: string) => {
      openTab({
        type: 'template-editor',
        title: name,
        icon: 'file-text',
        path: `/templates/${id}`,
        entityId: id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  const handleDeleteTemplate = useCallback(async () => {
    if (!deleteConfirm) return

    const success = await deleteTemplate(deleteConfirm)
    if (success) {
      toast.success('Template deleted')
    } else {
      toast.error('Failed to delete template')
    }
    setDeleteConfirm(null)
  }, [deleteConfirm, deleteTemplate])

  const handleDuplicateTemplate = useCallback(async () => {
    if (!duplicateId || !duplicateName.trim()) return

    const result = await duplicateTemplate(duplicateId, duplicateName.trim())
    if (result) {
      toast.success('Template duplicated')
    } else {
      toast.error('Failed to duplicate template')
    }
    setDuplicateId(null)
    setDuplicateName('')
  }, [duplicateId, duplicateName, duplicateTemplate])

  const builtInTemplates = templates.filter((t) => t.isBuiltIn)
  const customTemplates = templates.filter((t) => !t.isBuiltIn)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Templates</h3>
          <p className="text-sm text-muted-foreground">
            Manage note templates for quick note creation
          </p>
        </div>
        <Button onClick={handleCreateTemplate}>
          <Plus className="w-4 h-4 mr-2" />
          New Template
        </Button>
      </div>

      <Separator />

      {isLoading ? (
        <div className="text-muted-foreground text-sm">Loading templates...</div>
      ) : (
        <div className="space-y-6">
          {/* Built-in Templates */}
          {builtInTemplates.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
                Built-in Templates
              </h4>
              <div className="space-y-2">
                {builtInTemplates.map((template) => (
                  <TemplateListItem
                    key={template.id}
                    template={template}
                    onEdit={() => handleEditTemplate(template.id, template.name)}
                    onDuplicate={() => {
                      setDuplicateId(template.id)
                      setDuplicateName(`${template.name} (Copy)`)
                    }}
                    onDelete={null} // Can't delete built-in
                  />
                ))}
              </div>
            </div>
          )}

          {/* Custom Templates */}
          {customTemplates.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
                My Templates
              </h4>
              <div className="space-y-2">
                {customTemplates.map((template) => (
                  <TemplateListItem
                    key={template.id}
                    template={template}
                    onEdit={() => handleEditTemplate(template.id, template.name)}
                    onDuplicate={() => {
                      setDuplicateId(template.id)
                      setDuplicateName(`${template.name} (Copy)`)
                    }}
                    onDelete={() => setDeleteConfirm(template.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {customTemplates.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <FileText className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>No custom templates yet</p>
              <p className="text-sm">Create a template to get started</p>
            </div>
          )}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this template? This action cannot be undone. Notes
              created from this template will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteTemplate}
              className="bg-destructive text-destructive-foreground"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Duplicate Dialog */}
      <AlertDialog open={!!duplicateId} onOpenChange={() => setDuplicateId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Duplicate Template</AlertDialogTitle>
            <AlertDialogDescription>Enter a name for the new template copy.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Input
              value={duplicateName}
              onChange={(e) => setDuplicateName(e.target.value)}
              placeholder="Template name"
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDuplicateTemplate}>Duplicate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface TemplateListItemProps {
  template: {
    id: string
    name: string
    description?: string
    icon?: string | null
    isBuiltIn: boolean
  }
  onEdit: () => void
  onDuplicate: () => void
  onDelete: (() => void) | null
}

function TemplateListItem({ template, onEdit, onDuplicate, onDelete }: TemplateListItemProps) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/30 transition-colors group">
      {/* Icon */}
      <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-md bg-muted text-xl">
        {template.icon || <FileText className="w-5 h-5 text-muted-foreground" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{template.name}</span>
          {template.isBuiltIn && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              <Lock className="w-3 h-3" />
              Built-in
            </span>
          )}
        </div>
        {template.description && (
          <p className="text-sm text-muted-foreground truncate">{template.description}</p>
        )}
      </div>

      {/* Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="w-4 h-4 mr-2" />
            {template.isBuiltIn ? 'View' : 'Edit'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}>
            <Copy className="w-4 h-4 mr-2" />
            Duplicate
          </DropdownMenuItem>
          {onDelete && (
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
