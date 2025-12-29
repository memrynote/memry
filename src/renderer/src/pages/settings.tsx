/**
 * Settings Page
 *
 * Provides application settings including template management.
 * Opens as a singleton tab.
 */

import { useState, useCallback, useEffect } from 'react'
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
  Info,
  Brain,
  Loader2,
  CheckCircle,
  XCircle,
  RefreshCw,
  Eye,
  EyeOff
} from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useTemplates } from '@/hooks/use-templates'
import { useJournalSettings } from '@/hooks/use-journal-settings'
import { useTabs } from '@/contexts/tabs'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

type SettingsSection = 'general' | 'templates' | 'journal' | 'vault' | 'appearance' | 'ai'

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
          <SettingsNavItem
            icon={<Brain className="w-4 h-4" />}
            label="AI Assistant"
            isActive={activeSection === 'ai'}
            onClick={() => setActiveSection('ai')}
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
            {activeSection === 'ai' && <AISettings />}
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
        toast.success(templateId ? 'Default template updated' : 'Default template cleared')
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
        <p className="text-sm text-muted-foreground">Journal settings and preferences</p>
      </div>

      <Separator />

      {/* Default Template Setting */}
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium">Default Template</label>
          <p className="text-sm text-muted-foreground mt-1">
            New journal entries will start with this template. You can always change it when
            creating an entry.
          </p>
        </div>

        <Select
          value={settings.defaultTemplate ?? 'none'}
          onValueChange={handleTemplateChange}
          disabled={isLoadingTemplates || isLoadingSettings}
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue placeholder="Select a template">
              {isLoadingSettings
                ? 'Loading...'
                : settings.defaultTemplate
                  ? (defaultTemplateName ?? 'Unknown template')
                  : 'None (ask each time)'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              <span className="flex items-center gap-2">None (ask each time)</span>
            </SelectItem>
            {templates.map((template) => (
              <SelectItem key={template.id} value={template.id}>
                <span className="flex items-center gap-2">
                  {template.icon && <span>{template.icon}</span>}
                  {template.name}
                  {template.isBuiltIn && <Lock className="w-3 h-3 text-muted-foreground ml-1" />}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Info hint */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            When a default template is set, new journal entries will be created with the template
            content automatically. A small indicator will appear letting you change the template or
            start blank.
          </p>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// AI Settings
// ============================================================================

function AISettings() {
  const [settings, setSettings] = useState<{
    openaiApiKey: string | null
    enabled: boolean
    embeddingModel: string
  }>({
    openaiApiKey: null,
    enabled: false,
    embeddingModel: 'text-embedding-3-small'
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isReindexing, setIsReindexing] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [reindexProgress, setReindexProgress] = useState<{
    current: number
    total: number
    phase: string
  } | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async (): Promise<void> => {
      try {
        const aiSettings = await window.api.settings.getAISettings()
        setSettings(aiSettings)
        // Only show masked version if key exists
        if (aiSettings.openaiApiKey) {
          setApiKeyInput('sk-****************************')
        }
      } catch (error) {
        console.error('Failed to load AI settings:', error)
      } finally {
        setIsLoading(false)
      }
    }
    loadSettings()
  }, [])

  // Subscribe to embedding progress events
  useEffect(() => {
    const unsubscribe = window.api.onEmbeddingProgress((event) => {
      setReindexProgress(event)
      if (event.phase === 'complete') {
        setTimeout(() => {
          setIsReindexing(false)
          setReindexProgress(null)
        }, 1000)
      }
    })
    return unsubscribe
  }, [])

  const handleSaveApiKey = useCallback(async () => {
    // Don't save if it's the masked placeholder
    if (apiKeyInput.startsWith('sk-****')) {
      toast.info('Enter a new API key to update')
      return
    }

    setIsSaving(true)
    try {
      const result = await window.api.settings.setAISettings({
        openaiApiKey: apiKeyInput || null
      })
      if (result.success) {
        toast.success('API key saved')
        setSettings((prev) => ({ ...prev, openaiApiKey: apiKeyInput || null }))
        if (apiKeyInput) {
          setApiKeyInput('sk-****************************')
        }
      } else {
        toast.error(result.error || 'Failed to save API key')
      }
    } catch (error) {
      toast.error('Failed to save API key')
    } finally {
      setIsSaving(false)
    }
  }, [apiKeyInput])

  const handleToggleEnabled = useCallback(async (enabled: boolean) => {
    try {
      const result = await window.api.settings.setAISettings({ enabled })
      if (result.success) {
        setSettings((prev) => ({ ...prev, enabled }))
        toast.success(enabled ? 'AI features enabled' : 'AI features disabled')
      } else {
        toast.error(result.error || 'Failed to update setting')
      }
    } catch (error) {
      toast.error('Failed to update setting')
    }
  }, [])

  const handleTestConnection = useCallback(async () => {
    setIsTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.settings.testAIConnection()
      setTestResult(result)
      if (result.success) {
        toast.success('Connection successful!')
      } else {
        toast.error(result.error || 'Connection failed')
      }
    } catch (error) {
      setTestResult({ success: false, error: 'Connection test failed' })
      toast.error('Connection test failed')
    } finally {
      setIsTesting(false)
    }
  }, [])

  const handleReindexEmbeddings = useCallback(async () => {
    setIsReindexing(true)
    setReindexProgress({ current: 0, total: 0, phase: 'scanning' })
    try {
      const result = await window.api.settings.reindexEmbeddings()
      if (result.success) {
        toast.success('Embeddings reindexed successfully')
        setIsReindexing(false)

      } else {
        toast.error(result.error || 'Failed to reindex embeddings')
        setIsReindexing(false)
        setReindexProgress(null)
      }
    } catch (error) {
      toast.error('Failed to reindex embeddings')
      setIsReindexing(false)
      setReindexProgress(null)
    }
  }, [])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">AI Assistant</h3>
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">AI Assistant</h3>
        <p className="text-sm text-muted-foreground">
          Configure AI-powered features like smart filing suggestions
        </p>
      </div>

      <Separator />

      {/* Enable/Disable AI */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label htmlFor="ai-enabled">Enable AI Features</Label>
          <p className="text-sm text-muted-foreground">
            Use AI to suggest folders and tags when filing items
          </p>
        </div>
        <Switch
          id="ai-enabled"
          checked={settings.enabled}
          onCheckedChange={handleToggleEnabled}
          disabled={!settings.openaiApiKey}
        />
      </div>

      <Separator />

      {/* OpenAI API Key */}
      <div className="space-y-4">
        <div>
          <Label htmlFor="api-key">OpenAI API Key</Label>
          <p className="text-sm text-muted-foreground mt-1">
            Required for AI-powered suggestions. Get your key from{' '}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              OpenAI
            </a>
          </p>
        </div>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="api-key"
              type={showApiKey ? 'text' : 'password'}
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="sk-..."
              className="pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-3"
              onClick={() => setShowApiKey(!showApiKey)}
            >
              {showApiKey ? (
                <EyeOff className="w-4 h-4 text-muted-foreground" />
              ) : (
                <Eye className="w-4 h-4 text-muted-foreground" />
              )}
            </Button>
          </div>
          <Button onClick={handleSaveApiKey} disabled={isSaving}>
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
          </Button>
        </div>

        {/* Test Connection */}
        {settings.openaiApiKey && (
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={handleTestConnection} disabled={isTesting}>
              {isTesting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Testing...
                </>
              ) : (
                'Test Connection'
              )}
            </Button>
            {testResult && (
              <span
                className={cn(
                  'flex items-center gap-1 text-sm',
                  testResult.success ? 'text-green-600' : 'text-red-600'
                )}
              >
                {testResult.success ? (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    Connected
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4" />
                    {testResult.error || 'Failed'}
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </div>

      <Separator />

      {/* Reindex Embeddings */}
      <div className="space-y-4">
        <div>
          <Label>Embedding Index</Label>
          <p className="text-sm text-muted-foreground mt-1">
            Rebuild the AI embeddings index for all notes. This enables better similarity matching
            for filing suggestions.
          </p>
        </div>

        <Button
          variant="outline"
          onClick={handleReindexEmbeddings}
          disabled={isReindexing || !settings.openaiApiKey || !settings.enabled}
        >
          {isReindexing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Reindexing...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 mr-2" />
              Rebuild Index
            </>
          )}
        </Button>

        {reindexProgress && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>
                {reindexProgress.phase === 'scanning'
                  ? 'Scanning notes...'
                  : reindexProgress.phase === 'embedding'
                    ? 'Generating embeddings...'
                    : 'Complete!'}
              </span>
              <span>
                {reindexProgress.current} / {reindexProgress.total}
              </span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{
                  width: `${reindexProgress.total > 0 ? (reindexProgress.current / reindexProgress.total) * 100 : 0}%`
                }}
              />
            </div>
          </div>
        )}

        {/* Info hint */}
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted/50 text-sm">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <p className="text-muted-foreground">
            The embedding index is built automatically when notes are created or modified. Use this
            button to rebuild from scratch if suggestions seem inaccurate.
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
