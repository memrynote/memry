import { ScrollArea } from '@/components/ui/scroll-area'
import {
  FileText,
  Settings as SettingsIcon,
  FolderOpen,
  Palette,
  BookOpen,
  Brain,
  PenLine,
  Tags,
  ListChecks,
  Inbox,
  List,
  Key,
  User,
  CalendarDays,
  Terminal,
  Import,
  LayoutGrid
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { GeneralSettings } from './settings/general-section'
import { EditorSettings } from './settings/editor-section'
import { TemplatesSettings } from './settings/templates-section'
import { JournalSettings } from './settings/journal-section'
import { VaultSettings } from './settings/vault-section'
import { AppearanceSettings } from './settings/appearance-section'
import { AISettings } from './settings/ai-section'
import { TagsSettings } from './settings/tags-section'
import { PropertiesSettings } from './settings/properties-section'
import { TasksSettings } from './settings/tasks-section'
import { InboxSettings } from './settings/inbox-section'
import { CalendarSettingsSection } from './settings/calendar-section'
import { ShortcutsSettings } from './settings/shortcuts-section'
import { AccountSettings } from './settings/account-section'
import { CommandLineSettings } from './settings/command-line-section'
import { ImportSettings } from './settings/import-section'
import { FeaturesSection } from './settings/features-section'
import { useSettingsModal } from '@/contexts/settings-modal-context'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useT } from '@memry/i18n/renderer'

export function SettingsPage() {
  const { activeSection, focusTarget, focusRequestId, setActiveSection } = useSettingsModal()
  const { flags } = useFeatureFlags()
  const { t } = useT('settings')
  const isAssistantSection =
    activeSection === 'ai' || activeSection === 'agent-providers' || activeSection === 'agent-mcp'
  const initialAssistantPanel =
    activeSection === 'agent-providers' || activeSection === 'agent-mcp' ? activeSection : undefined

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="w-60 shrink-0 pt-5 pb-4 overflow-y-auto min-h-0 bg-sidebar border-e border-border text-xs/4 font-[family-name:var(--font-sans)]">
        <SettingsNavGroup label={t('page.nav.groups.account')}>
          <SettingsNavItem
            icon={<User className="w-3.5 h-3.5" />}
            label={t('page.nav.items.account')}
            isActive={activeSection === 'account'}
            onClick={() => setActiveSection('account')}
          />
        </SettingsNavGroup>

        <SettingsNavGroup label={t('page.nav.groups.application')}>
          <SettingsNavItem
            icon={<SettingsIcon className="w-3.5 h-3.5" />}
            label={t('page.nav.items.general')}
            isActive={activeSection === 'general'}
            onClick={() => setActiveSection('general')}
          />
          <SettingsNavItem
            icon={<Palette className="w-3.5 h-3.5" />}
            label={t('page.nav.items.appearance')}
            isActive={activeSection === 'appearance'}
            onClick={() => setActiveSection('appearance')}
          />
          <SettingsNavItem
            icon={<Key className="w-3.5 h-3.5" />}
            label={t('page.nav.items.shortcuts')}
            isActive={activeSection === 'shortcuts'}
            onClick={() => setActiveSection('shortcuts')}
          />
          <SettingsNavItem
            icon={<Terminal className="w-3.5 h-3.5" />}
            label={t('page.nav.items.commandLine')}
            isActive={activeSection === 'command-line'}
            onClick={() => setActiveSection('command-line')}
          />
        </SettingsNavGroup>

        <SettingsNavGroup label={t('page.nav.groups.editing')}>
          <SettingsNavItem
            icon={<PenLine className="w-3.5 h-3.5" />}
            label={t('page.nav.items.editor')}
            isActive={activeSection === 'editor'}
            onClick={() => setActiveSection('editor')}
          />
          <SettingsNavItem
            icon={<FileText className="w-3.5 h-3.5" />}
            label={t('page.nav.items.templates')}
            isActive={activeSection === 'templates'}
            onClick={() => setActiveSection('templates')}
          />
        </SettingsNavGroup>

        <SettingsNavGroup label={t('page.nav.groups.modules')}>
          <SettingsNavItem
            icon={<LayoutGrid className="w-3.5 h-3.5" />}
            label={t('page.nav.items.features')}
            isActive={activeSection === 'features'}
            onClick={() => setActiveSection('features')}
          />
          <SettingsNavItem
            icon={<BookOpen className="w-3.5 h-3.5" />}
            label={t('page.nav.items.journal')}
            isActive={activeSection === 'journal'}
            disabled={!flags.journal}
            onClick={() => setActiveSection('journal')}
          />
          <SettingsNavItem
            icon={<ListChecks className="w-3.5 h-3.5" />}
            label={t('page.nav.items.tasks')}
            isActive={activeSection === 'tasks'}
            disabled={!flags.tasks}
            onClick={() => setActiveSection('tasks')}
          />
          <SettingsNavItem
            icon={<Inbox className="w-3.5 h-3.5" />}
            label={t('page.nav.items.inbox')}
            isActive={activeSection === 'inbox'}
            onClick={() => setActiveSection('inbox')}
          />
          <SettingsNavItem
            icon={<CalendarDays className="w-3.5 h-3.5" />}
            label={t('page.nav.items.calendar')}
            isActive={activeSection === 'calendar'}
            disabled={!flags.calendar}
            onClick={() => setActiveSection('calendar')}
          />
        </SettingsNavGroup>

        <SettingsNavGroup label={t('page.nav.groups.services')}>
          <SettingsNavItem
            icon={<Brain className="w-3.5 h-3.5" />}
            label={t('page.nav.items.ai')}
            isActive={isAssistantSection}
            onClick={() => setActiveSection('ai')}
          />
        </SettingsNavGroup>

        <SettingsNavGroup label={t('page.nav.groups.data')}>
          <SettingsNavItem
            icon={<FolderOpen className="w-3.5 h-3.5" />}
            label={t('page.nav.items.vault')}
            isActive={activeSection === 'vault'}
            onClick={() => setActiveSection('vault')}
          />
          <SettingsNavItem
            icon={<Tags className="w-3.5 h-3.5" />}
            label={t('page.nav.items.tags')}
            isActive={activeSection === 'tags'}
            onClick={() => setActiveSection('tags')}
          />
          <SettingsNavItem
            icon={<List className="w-3.5 h-3.5" />}
            label={t('page.nav.items.properties')}
            isActive={activeSection === 'properties'}
            onClick={() => setActiveSection('properties')}
          />
          <SettingsNavItem
            icon={<Import className="w-3.5 h-3.5" />}
            label={t('page.nav.items.import')}
            isActive={activeSection === 'import'}
            onClick={() => setActiveSection('import')}
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
            {activeSection === 'inbox' && <InboxSettings />}
            {activeSection === 'calendar' && <CalendarSettingsSection />}
            {activeSection === 'vault' && <VaultSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
            {isAssistantSection && (
              <AISettings
                initialOpenPanel={initialAssistantPanel}
                focusTarget={focusTarget}
                focusRequestId={focusRequestId}
              />
            )}
            {activeSection === 'tags' && <TagsSettings />}
            {activeSection === 'properties' && <PropertiesSettings />}
            {activeSection === 'import' && <ImportSettings />}
            {activeSection === 'shortcuts' && <ShortcutsSettings />}
            {activeSection === 'command-line' && <CommandLineSettings />}
            {activeSection === 'account' && <AccountSettings />}
            {activeSection === 'features' && <FeaturesSection />}
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
  disabled?: boolean
}

function SettingsNavItem({
  icon,
  label,
  isActive,
  onClick,
  disabled = false
}: SettingsNavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className={cn(
        'relative flex items-center h-7 shrink-0 rounded-[5px] px-3 transition-colors',
        disabled
          ? 'opacity-50 text-muted-foreground cursor-not-allowed'
          : isActive
            ? 'bg-sidebar-accent text-foreground font-medium'
            : 'text-muted-foreground hover:bg-sidebar-accent'
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="ps-2 text-[13px]/4 font-medium">{label}</span>
      {isActive && !disabled && (
        <span className="absolute start-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-[var(--tint)] rounded-e-sm" />
      )}
    </button>
  )
}

export default SettingsPage
