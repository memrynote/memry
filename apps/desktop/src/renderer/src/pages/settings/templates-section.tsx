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
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { SettingsHeader, SettingsGroup } from '@/components/settings/settings-primitives'

export function TemplatesSettings() {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')
  const { templates, isLoading, deleteTemplate, duplicateTemplate } = useTemplates()
  const { openTab } = useTabs()
  const { close: closeSettings } = useSettingsModal()
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [duplicateName, setDuplicateName] = useState('')
  const [duplicateId, setDuplicateId] = useState<string | null>(null)

  const handleCreateTemplate = useCallback(() => {
    closeSettings()
    openTab({
      type: 'template-editor',
      title: t('templates.newTemplateTitle'),
      icon: 'file-text',
      path: '/templates/new',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  }, [closeSettings, openTab, t])

  const handleEditTemplate = useCallback(
    (id: string, name: string) => {
      closeSettings()
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
    [closeSettings, openTab]
  )

  const handleDeleteTemplate = useCallback(async () => {
    if (!deleteConfirm) return

    const success = await deleteTemplate(deleteConfirm)
    if (success) {
      toast.success(t('templates.toasts.deleted'))
    } else {
      toast.error(t('templates.toasts.deleteFailed'))
    }
    setDeleteConfirm(null)
  }, [deleteConfirm, deleteTemplate, t])

  const handleDuplicateTemplate = useCallback(async () => {
    if (!duplicateId || !duplicateName.trim()) return

    const result = await duplicateTemplate(duplicateId, duplicateName.trim())
    if (result) {
      toast.success(t('templates.toasts.duplicated'))
    } else {
      toast.error(t('templates.toasts.duplicateFailed'))
    }
    setDuplicateId(null)
    setDuplicateName('')
  }, [duplicateId, duplicateName, duplicateTemplate, t])

  const builtInTemplates = templates.filter((t) => t.isBuiltIn)
  const customTemplates = templates.filter((t) => !t.isBuiltIn)

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
        title={t('templates.header.title')}
        subtitle={t('templates.header.subtitle')}
        action={
          <Button
            onClick={handleCreateTemplate}
            variant="outline"
            size="sm"
            className="gap-1.5 border-[var(--tint)] text-[var(--tint)] hover:bg-[var(--tint)]/10"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('templates.actions.new')}
          </Button>
        }
      />

      {isLoading ? (
        <div className="text-muted-foreground text-xs/4 py-4">{t('templates.loading')}</div>
      ) : (
        <>
          {builtInTemplates.length > 0 && (
            <SettingsGroup label={t('templates.groups.builtIn')}>
              {builtInTemplates.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  onSelect={() => handleEditTemplate(template.id, template.name)}
                  onEdit={() => handleEditTemplate(template.id, template.name)}
                  onDuplicate={() => {
                    setDuplicateId(template.id)
                    setDuplicateName(t('templates.copySuffix', { name: template.name }))
                  }}
                  onDelete={null}
                />
              ))}
            </SettingsGroup>
          )}

          {customTemplates.length > 0 && (
            <SettingsGroup label={t('templates.groups.myTemplates')}>
              {customTemplates.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  onSelect={() => handleEditTemplate(template.id, template.name)}
                  onEdit={() => handleEditTemplate(template.id, template.name)}
                  onDuplicate={() => {
                    setDuplicateId(template.id)
                    setDuplicateName(t('templates.copySuffix', { name: template.name }))
                  }}
                  onDelete={() => setDeleteConfirm(template.id)}
                />
              ))}
            </SettingsGroup>
          )}

          {customTemplates.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <FileText className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-[13px]/4 font-medium">{t('templates.empty.title')}</p>
              <p className="text-xs/4">{t('templates.empty.description')}</p>
            </div>
          )}
        </>
      )}

      <AlertDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('templates.dialogs.delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('templates.dialogs.delete.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDeleteTemplate()}
              className="bg-destructive text-destructive-foreground"
            >
              {tCommon('button.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!duplicateId} onOpenChange={() => setDuplicateId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('templates.dialogs.duplicate.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('templates.dialogs.duplicate.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Input
              value={duplicateName}
              onChange={(e) => setDuplicateName(e.target.value)}
              placeholder={t('templates.dialogs.duplicate.placeholder')}
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('button.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDuplicateTemplate()}>
              {t('templates.actions.duplicate')}
            </AlertDialogAction>
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
  onSelect: () => void
  onEdit: () => void
  onDuplicate: () => void
  onDelete: (() => void) | null
}

function TemplateRow({ template, onSelect, onEdit, onDuplicate, onDelete }: TemplateRowProps) {
  const { t } = useT('settings')

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={template.name}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className="flex items-center justify-between h-11 py-3 px-4 shrink-0 group cursor-pointer hover:bg-muted/40"
    >
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
      <div className="flex items-center gap-1 shrink-0 ms-4">
        {template.isBuiltIn ? (
          <Lock className="w-3.5 h-3.5 text-muted-foreground/50" />
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="p-1 rounded text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-foreground transition-all"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="w-4 h-4 me-2" />
                {t('templates.actions.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDuplicate}>
                <Copy className="w-4 h-4 me-2" />
                {t('templates.actions.duplicate')}
              </DropdownMenuItem>
              {onDelete && (
                <DropdownMenuItem onClick={onDelete} className="text-destructive">
                  <Trash2 className="w-4 h-4 me-2" />
                  {t('templates.actions.delete')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )
}
