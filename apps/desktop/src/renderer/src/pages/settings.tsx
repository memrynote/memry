import { ScrollArea } from '@/components/ui/scroll-area'
import {
  FileText,
  Settings as SettingsIcon,
  FolderOpen,
  Palette,
  BookOpen,
  Brain,
  PenLine,
  Plug,
  Tags,
  ListChecks,
  List,
  Key,
  User
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { GeneralSettings } from './settings/general-section'
import { EditorSettings } from './settings/editor-section'
import { TemplatesSettings } from './settings/templates-section'
import { JournalSettings } from './settings/journal-section'
import { VaultSettings } from './settings/vault-section'
import { AppearanceSettings } from './settings/appearance-section'
import { AISettings } from './settings/ai-section'
import { IntegrationsSettings } from './settings/integrations-section'
import { TagsSettings } from './settings/tags-section'
import { PropertiesSettings } from './settings/properties-section'
import { TasksSettings } from './settings/tasks-section'
import { ShortcutsSettings } from './settings/shortcuts-section'
import { AccountSettings } from './settings/account-section'
import { useSettingsModal } from '@/contexts/settings-modal-context'

export function SettingsPage() {
  const { activeSection, setActiveSection } = useSettingsModal()

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="w-60 shrink-0 pt-5 pb-4 overflow-y-auto min-h-0 bg-sidebar border-r border-border text-xs/4 font-[family-name:var(--font-sans)]">
        <div className="flex items-center pb-4 px-5">
          <span className="text-sm/4.5 font-semibold text-foreground tracking-[-0.01em]">
            Settings
          </span>
        </div>

        <SettingsNavGroup label="Workspace">
          <SettingsNavItem
            icon={<User className="w-3.5 h-3.5" />}
            label="Account"
            isActive={activeSection === 'account'}
            onClick={() => setActiveSection('account')}
          />
          <SettingsNavItem
            icon={<SettingsIcon className="w-3.5 h-3.5" />}
            label="General"
            isActive={activeSection === 'general'}
            onClick={() => setActiveSection('general')}
          />
          <SettingsNavItem
            icon={<FileText className="w-3.5 h-3.5" />}
            label="Templates"
            isActive={activeSection === 'templates'}
            onClick={() => setActiveSection('templates')}
          />
          <SettingsNavItem
            icon={<PenLine className="w-3.5 h-3.5" />}
            label="Editor"
            isActive={activeSection === 'editor'}
            onClick={() => setActiveSection('editor')}
          />
          <SettingsNavItem
            icon={<BookOpen className="w-3.5 h-3.5" />}
            label="Journal"
            isActive={activeSection === 'journal'}
            onClick={() => setActiveSection('journal')}
          />
          <SettingsNavItem
            icon={<ListChecks className="w-3.5 h-3.5" />}
            label="Tasks"
            isActive={activeSection === 'tasks'}
            onClick={() => setActiveSection('tasks')}
          />
        </SettingsNavGroup>

        <SettingsNavGroup label="Preferences">
          <SettingsNavItem
            icon={<Palette className="w-3.5 h-3.5" />}
            label="Appearance"
            isActive={activeSection === 'appearance'}
            onClick={() => setActiveSection('appearance')}
          />
          <SettingsNavItem
            icon={<Key className="w-3.5 h-3.5" />}
            label="Shortcuts"
            isActive={activeSection === 'shortcuts'}
            onClick={() => setActiveSection('shortcuts')}
          />
        </SettingsNavGroup>

        <SettingsNavGroup label="Services">
          <SettingsNavItem
            icon={<Brain className="w-3.5 h-3.5" />}
            label="AI Assistant"
            isActive={activeSection === 'ai'}
            onClick={() => setActiveSection('ai')}
          />
          <SettingsNavItem
            icon={<Plug className="w-3.5 h-3.5" />}
            label="Integrations"
            isActive={activeSection === 'integrations'}
            onClick={() => setActiveSection('integrations')}
          />
        </SettingsNavGroup>

        <SettingsNavGroup label="Data">
          <SettingsNavItem
            icon={<FolderOpen className="w-3.5 h-3.5" />}
            label="Vault"
            isActive={activeSection === 'vault'}
            onClick={() => setActiveSection('vault')}
          />
          <SettingsNavItem
            icon={<Tags className="w-3.5 h-3.5" />}
            label="Tags"
            isActive={activeSection === 'tags'}
            onClick={() => setActiveSection('tags')}
          />
          <SettingsNavItem
            icon={<List className="w-3.5 h-3.5" />}
            label="Properties"
            isActive={activeSection === 'properties'}
            onClick={() => setActiveSection('properties')}
          />
        </SettingsNavGroup>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
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
            {activeSection === 'integrations' && <IntegrationsSettings />}
            {activeSection === 'tags' && <TagsSettings />}
            {activeSection === 'properties' && <PropertiesSettings />}
            {activeSection === 'shortcuts' && <ShortcutsSettings />}
            {activeSection === 'account' && <AccountSettings />}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

function SettingsNavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col mt-4 first:mt-0 px-2 gap-px">
      <span className="uppercase pb-1.5 px-3 text-[11px]/3.5 font-medium tracking-[0.05em] text-muted-foreground/60">
        {label}
      </span>
      {children}
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
        'relative flex items-center h-7 shrink-0 rounded-[5px] px-3 transition-colors',
        isActive
          ? 'bg-sidebar-accent text-foreground font-medium'
          : 'text-muted-foreground hover:bg-sidebar-accent'
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="pl-2 text-[13px]/4 font-medium">{label}</span>
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-[var(--tint)] rounded-r-sm" />
      )}
    </button>
  )
}

export default SettingsPage
