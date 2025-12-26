/**
 * Settings Page
 *
 * Provides application settings including template management.
 * Opens as a singleton tab.
 */

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import {
  FileText,
  Plus,
  MoreHorizontal,
  Pencil,
  Copy,
  Trash2,
  Lock,
  ChevronRight,
  Settings as SettingsIcon,
  FolderOpen,
  Palette,
  BookOpen,
  Info
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTemplates } from '@/hooks/use-templates'
import { useJournalSettings } from '@/hooks/use-journal-settings'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

type SettingsSection = 'general' | 'templates' | 'journal' | 'vault' | 'appearance'

// ============================================================================
// Main Component
// ============================================================================

export function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('templates')

  return (
    <div className="h-full flex">
      {/* Sidebar */}
      <div className="w-48 border-r bg-muted/30 flex-shrink-0">
        <div className="p-4">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Settings
          </h2>
        </div>
        <nav className="px-2">
          <SettingsNavItem
            icon={<SettingsIcon className="w-4 h-4" />}
            label="General"
            isActive={activeSection === 'general'}
            onClick={() => setActiveSection('general')}
          />
          <SettingsNavItem
            icon={<FileText className="w-4 h-4" />}
            label="Templates"
            isActive={activeSection === 'templates'}
            onClick={() => setActiveSection('templates')}
          />
          <SettingsNavItem
            icon={<BookOpen className="w-4 h-4" />}
            label="Journal"
            isActive={activeSection === 'journal'}
            onClick={() => setActiveSection('journal')}
          />
          <SettingsNavItem
            icon={<FolderOpen className="w-4 h-4" />}
            label="Vault"
            isActive={activeSection === 'vault'}
            onClick={() => setActiveSection('vault')}
          />
          <SettingsNavItem
            icon={<Palette className="w-4 h-4" />}
            label="Appearance"
            isActive={activeSection === 'appearance'}
            onClick={() => setActiveSection('appearance')}
          />
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-6 max-w-3xl">
            {activeSection === 'general' && <GeneralSettings />}
            {activeSection === 'templates' && <TemplatesSettings />}
            {activeSection === 'journal' && <JournalSettings />}
            {activeSection === 'vault' && <VaultSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

// ============================================================================
// Navigation Item
// ============================================================================

interface SettingsNavItemProps {
  icon: React.ReactNode
  label: string
  isActive: boolean
  onClick: () => void
}

function SettingsNavItem({ icon, label, isActive, onClick }: SettingsNavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
        'hover:bg-accent/50',
        isActive && 'bg-accent text-accent-foreground'
      )}
    >
      {icon}
      <span>{label}</span>
      {isActive && <ChevronRight className="w-4 h-4 ml-auto" />}
    </button>
  )
}

// ============================================================================
// General Settings
// ============================================================================

function GeneralSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">General</h3>
        <p className="text-sm text-muted-foreground">General application settings</p>
      </div>
      <Separator />
      <div className="text-muted-foreground text-sm">General settings coming soon...</div>
    </div>
  )
}

// ============================================================================
// Templates Settings
// ============================================================================

function TemplatesSettings() {
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

// ============================================================================
// Template List Item
// ============================================================================

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

// ============================================================================
// Journal Settings
// ============================================================================

function JournalSettings() {
  const { templates, isLoading: isLoadingTemplates } = useTemplates()
  const { settings, setDefaultTemplate, isLoading: isLoadingSettings } = useJournalSettings()

  const handleTemplateChange = useCallback(
    async (value: string) => {
      const templateId = value === 'none' ? null : value
      const success = await setDefaultTemplate(templateId)
      if (success) {
        toast.success(
          templateId ? 'Default template updated' : 'Default template cleared'
        )
      } else {
        toast.error('Failed to update default template')
      }
    },
    [setDefaultTemplate]
  )

  // Find the current default template name for display
  const defaultTemplateName = settings.defaultTemplate
    ? templates.find((t) => t.id === settings.defaultTemplate)?.name
    : null

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Journal</h3>
        <p className="text-sm text-muted-foreground">
          Journal settings and preferences
        </p>
      </div>

      <Separator />

      {/* Default Template Setting */}
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium">Default Template</label>
          <p className="text-sm text-muted-foreground mt-1">
            New journal entries will start with this template. You can always change it when creating an entry.
          </p>
        </div>

        <Select
          value={settings.defaultTemplate ?? 'none'}
          onValueChange={handleTemplateChange}
          disabled={isLoadingTemplates || isLoadingSettings}
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue placeholder="Select a template">
              {isLoadingSettings ? (
                'Loading...'
              ) : settings.defaultTemplate ? (
                defaultTemplateName ?? 'Unknown template'
              ) : (
                'None (ask each time)'
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              <span className="flex items-center gap-2">
                None (ask each time)
              </span>
            </SelectItem>
            {templates.map((template) => (
              <SelectItem key={template.id} value={template.id}>
                <span className="flex items-center gap-2">
                  {template.icon && <span>{template.icon}</span>}
                  {template.name}
                  {template.isBuiltIn && (
                    <Lock className="w-3 h-3 text-muted-foreground ml-1" />
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Info hint */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            When a default template is set, new journal entries will be created with the template content automatically.
            A small indicator will appear letting you change the template or start blank.
          </p>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Vault Settings (Placeholder)
// ============================================================================

function VaultSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Vault</h3>
        <p className="text-sm text-muted-foreground">Vault configuration and storage settings</p>
      </div>
      <Separator />
      <div className="text-muted-foreground text-sm">Vault settings coming soon...</div>
    </div>
  )
}

// ============================================================================
// Appearance Settings (Placeholder)
// ============================================================================

function AppearanceSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Appearance</h3>
        <p className="text-sm text-muted-foreground">Customize the look and feel</p>
      </div>
      <Separator />
      <div className="text-muted-foreground text-sm">Appearance settings coming soon...</div>
    </div>
  )
}

export default SettingsPage
