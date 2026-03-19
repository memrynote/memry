import { useState, useEffect } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  FileText,
  ChevronRight,
  Settings as SettingsIcon,
  FolderOpen,
  Palette,
  BookOpen,
  Brain,
  Cloud,
  PenLine,
  Plug,
  Tags,
  ListChecks
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { GeneralSettings } from './settings/general-section'
import { EditorSettings } from './settings/editor-section'
import { TemplatesSettings } from './settings/templates-section'
import { JournalSettings } from './settings/journal-section'
import { VaultSettings } from './settings/vault-section'
import { AppearanceSettings } from './settings/appearance-section'
import { AISettings } from './settings/ai-section'
import { SyncSettings } from './settings/sync-section'
import { IntegrationsSettings } from './settings/integrations-section'
import { TagsSettings } from './settings/tags-section'
import { TasksSettings } from './settings/tasks-section'

type SettingsSection =
  | 'general'
  | 'editor'
  | 'templates'
  | 'journal'
  | 'tasks'
  | 'vault'
  | 'appearance'
  | 'ai'
  | 'sync'
  | 'integrations'
  | 'tags'

export function SettingsPage() {
  const [activeSection, setActiveSection] = useState<SettingsSection>(() => {
    const saved = localStorage.getItem('memry_settings_section')
    return (saved as SettingsSection) || 'templates'
  })

  useEffect(() => {
    localStorage.setItem('memry_settings_section', activeSection)
  }, [activeSection])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'memry_settings_section' && e.newValue) {
        setActiveSection(e.newValue as SettingsSection)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
            icon={<PenLine className="w-4 h-4" />}
            label="Editor"
            isActive={activeSection === 'editor'}
            onClick={() => setActiveSection('editor')}
          />
          <SettingsNavItem
            icon={<BookOpen className="w-4 h-4" />}
            label="Journal"
            isActive={activeSection === 'journal'}
            onClick={() => setActiveSection('journal')}
          />
          <SettingsNavItem
            icon={<ListChecks className="w-4 h-4" />}
            label="Tasks"
            isActive={activeSection === 'tasks'}
            onClick={() => setActiveSection('tasks')}
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
          <SettingsNavItem
            icon={<Cloud className="w-4 h-4" />}
            label="Sync"
            isActive={activeSection === 'sync'}
            onClick={() => setActiveSection('sync')}
          />
          <SettingsNavItem
            icon={<Plug className="w-4 h-4" />}
            label="Integrations"
            isActive={activeSection === 'integrations'}
            onClick={() => setActiveSection('integrations')}
          />
          <SettingsNavItem
            icon={<Tags className="w-4 h-4" />}
            label="Tags"
            isActive={activeSection === 'tags'}
            onClick={() => setActiveSection('tags')}
          />
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-6 max-w-3xl mx-auto">
            {activeSection === 'general' && <GeneralSettings />}
            {activeSection === 'editor' && <EditorSettings />}
            {activeSection === 'templates' && <TemplatesSettings />}
            {activeSection === 'journal' && <JournalSettings />}
            {activeSection === 'tasks' && <TasksSettings />}
            {activeSection === 'vault' && <VaultSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
            {activeSection === 'ai' && <AISettings />}
            {activeSection === 'sync' && <SyncSettings />}
            {activeSection === 'integrations' && <IntegrationsSettings />}
            {activeSection === 'tags' && <TagsSettings />}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

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

export default SettingsPage
