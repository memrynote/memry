import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { SettingsHeader, SettingsGroup } from '@/components/settings/settings-primitives'

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
    <div className="flex flex-col antialiased text-xs/4">
      <SettingsHeader
        title="Templates"
        subtitle="Manage note templates for quick creation"
        action={
          <Button
            onClick={handleCreateTemplate}
            variant="outline"
            size="sm"
            className="gap-1.5 border-[var(--tint)] text-[var(--tint)] hover:bg-[var(--tint)]/10"
          >
            <Plus className="w-3.5 h-3.5" />
            New Template
          </Button>
        }
      />

      {isLoading ? (
        <div className="text-muted-foreground text-xs/4 py-4">Loading templates...</div>
      ) : (
        <>
          {builtInTemplates.length > 0 && (
            <SettingsGroup label="Built-in">
              {builtInTemplates.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  onEdit={() => handleEditTemplate(template.id, template.name)}
                  onDuplicate={() => {
                    setDuplicateId(template.id)
                    setDuplicateName(`${template.name} (Copy)`)
                  }}
                  onDelete={null}
                />
              ))}
            </SettingsGroup>
          )}

          {customTemplates.length > 0 && (
            <SettingsGroup label="My Templates">
              {customTemplates.map((template) => (
                <TemplateRow
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
            </SettingsGroup>
          )}

          {customTemplates.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <FileText className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-[13px]/4 font-medium">No custom templates yet</p>
              <p className="text-xs/4">Create a template to get started</p>
            </div>
          )}
        </>
      )}

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

interface TemplateRowProps {
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

function TemplateRow({ template, onEdit, onDuplicate, onDelete }: TemplateRowProps) {
  return (
    <div className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="text-muted-foreground shrink-0">
          {template.icon || <FileText className="w-3.5 h-3.5" />}
        </span>
        <div className="flex flex-col gap-px min-w-0">
          <span className="font-medium text-[13px]/4 text-foreground">{template.name}</span>
          {template.description && (
            <span className="text-xs/4 text-muted-foreground truncate">{template.description}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-4">
        {template.isBuiltIn ? (
          <Lock className="w-3.5 h-3.5 text-muted-foreground/50" />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1 rounded text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground transition-all">
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="w-4 h-4 mr-2" />
                Edit
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
        )}
      </div>
    </div>
  )
}
