import { useEffect, useMemo, useRef, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  PenLine,
  Settings as SettingsIcon,
  FolderOpen,
  Palette,
  Brain,
  Tags,
  Key,
  User,
  LayoutGrid,
  ChevronLeft,
  Download,
  Search
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
import { ImportSettings } from './settings/import-section'
import { FeaturesSection } from './settings/features-section'
import {
  PAGE_ROOT_SECTION,
  SECTION_ANCHORS,
  getSettingsPage,
  getSettingsParent,
  type SettingsPageId
} from './settings/settings-navigation'
import {
  SETTINGS_HIT_ATTR,
  SETTINGS_LABEL_ATTR,
  searchSettings,
  type SettingsSearchResult
} from './settings/settings-search'
import { useSettingsModal, type SettingsSection } from '@/contexts/settings-modal-context'
import { useT } from '@memry/i18n/renderer'

const ICON = 'w-3.5 h-3.5'

export function SettingsPage() {
  const { activeSection, focusTarget, focusRequestId, setActiveSection } = useSettingsModal()
  const { t } = useT('settings')
  const activePage = getSettingsPage(activeSection)
  const parent = getSettingsParent(activeSection)
  const contentRef = useRef<HTMLDivElement>(null)

  // Merged pages: jump to the anchor of the legacy section, or back to the top.
  useEffect(() => {
    const anchorId = SECTION_ANCHORS[activeSection]
    const target = (anchorId && document.getElementById(anchorId)) || contentRef.current
    // Optional call: jsdom does not implement scrollIntoView.
    target?.scrollIntoView?.({ block: 'start' })
  }, [activeSection])

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const results = useMemo(() => searchSettings(query, (key) => t(key)), [query, t])
  const selected: SettingsSearchResult | undefined = results[selectedIndex]

  const selectResult = (index: number, list: SettingsSearchResult[] = results) => {
    setSelectedIndex(index)
    const next = list[index]
    if (next && next.entry.section !== activeSection) setActiveSection(next.entry.section)
  }

  const handleQueryChange = (value: string) => {
    setQuery(value)
    // The first match opens and lights up as you type.
    selectResult(
      0,
      searchSettings(value, (key) => t(key))
    )
  }

  const highlightLabel = selected && selected.entry.kind !== 'page' ? selected.label : null
  useSettingsSearchHighlight(contentRef, highlightLabel, activeSection)

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // The dialog ignores this Escape while the query is non-empty (see settings-modal).
      if (query) setQuery('')
      return
    }
    if (results.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      selectResult((selectedIndex + step + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      focusHighlightedControl(contentRef.current)
    }
  }

  const navItem = (page: SettingsPageId, icon: React.ReactNode, label: string) => (
    <SettingsNavItem
      icon={icon}
      label={label}
      isActive={activePage === page}
      onClick={() => setActiveSection(PAGE_ROOT_SECTION[page])}
    />
  )

  return (
    <div className="flex-1 min-h-0 flex">
      <nav
        aria-label={t('page.title')}
        className="w-60 shrink-0 pt-3.5 pb-4 overflow-y-auto min-h-0 bg-sidebar border-e border-border text-xs/4 font-[family-name:var(--font-sans)]"
      >
        <div className="px-2.5 pb-3.5">
          <label className="flex items-center h-7.5 px-2.5 gap-2 rounded-[7px] border border-border bg-background focus-within:border-foreground focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--foreground)_8%,transparent)] transition-[border-color,box-shadow]">
            <Search className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="search"
              data-settings-search=""
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('page.search.placeholder')}
              aria-label={t('page.search.placeholder')}
              aria-controls="settings-search-results"
              aria-activedescendant={
                selected ? `settings-search-result-${selectedIndex}` : undefined
              }
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px]/4 text-foreground placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {query && <kbd className="font-mono text-[11px]/3.5 text-muted-foreground">esc</kbd>}
          </label>
        </div>

        {query ? (
          <SettingsSearchResults
            results={results}
            selectedIndex={selectedIndex}
            onSelect={(index) => selectResult(index)}
          />
        ) : (
          <>
            <div className="flex flex-col px-2 gap-px">
              {navItem('account', <User className={ICON} />, t('page.nav.items.account'))}
            </div>

            <SettingsNavGroup label={t('page.nav.groups.workspace')}>
              {navItem('general', <SettingsIcon className={ICON} />, t('page.nav.items.general'))}
              {navItem('appearance', <Palette className={ICON} />, t('page.nav.items.appearance'))}
              {navItem('editor', <PenLine className={ICON} />, t('page.nav.items.editor'))}
              {navItem('shortcuts', <Key className={ICON} />, t('page.nav.items.shortcuts'))}
            </SettingsNavGroup>

            <SettingsNavGroup label={t('page.nav.groups.features')}>
              {navItem('modules', <LayoutGrid className={ICON} />, t('page.nav.items.modules'))}
              {navItem('ai', <Brain className={ICON} />, t('page.nav.items.aiAgents'))}
            </SettingsNavGroup>

            <SettingsNavGroup label={t('page.nav.groups.data')}>
              {navItem('tags', <Tags className={ICON} />, t('page.nav.items.tagsProperties'))}
              {navItem('vault', <FolderOpen className={ICON} />, t('page.nav.items.vaultData'))}
              {navItem('import', <Download className={ICON} />, t('page.nav.items.import'))}
            </SettingsNavGroup>
          </>
        )}
      </nav>

      <div className="flex-1 min-h-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div ref={contentRef} className="p-6 max-w-3xl mx-auto">
            {parent && (
              <DrillInBar
                parentLabel={t(PARENT_LABEL_KEY[activePage])}
                currentLabel={t(`page.nav.items.${activeSection}`)}
                onBack={() => setActiveSection(parent)}
              />
            )}
            <SettingsPageContent
              section={activeSection}
              page={activePage}
              focusTarget={focusTarget}
              focusRequestId={focusRequestId}
            />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

const PARENT_LABEL_KEY: Record<SettingsPageId, string> = {
  account: 'page.nav.items.account',
  general: 'page.nav.items.general',
  appearance: 'page.nav.items.appearance',
  editor: 'page.nav.items.editor',
  shortcuts: 'page.nav.items.shortcuts',
  modules: 'page.nav.items.modules',
  ai: 'page.nav.items.aiAgents',
  tags: 'page.nav.items.tagsProperties',
  vault: 'page.nav.items.vaultData',
  import: 'page.nav.items.import'
}

interface SettingsPageContentProps {
  section: SettingsSection
  page: SettingsPageId
  focusTarget: ReturnType<typeof useSettingsModal>['focusTarget']
  focusRequestId: number
}

function SettingsPageContent({
  section,
  page,
  focusTarget,
  focusRequestId
}: SettingsPageContentProps) {
  const { setActiveSection } = useSettingsModal()

  switch (section) {
    case 'journal':
      return <JournalSettings />
    case 'tasks':
      return <TasksSettings />
    case 'inbox':
      return <InboxSettings />
    case 'calendar':
      return <CalendarSettingsSection />
  }

  switch (page) {
    case 'account':
      return <AccountSettings />
    case 'general':
      return <GeneralSettings />
    case 'appearance':
      return <AppearanceSettings />
    case 'editor':
      return (
        <StackedSections>
          <EditorSettings />
          <div id={SECTION_ANCHORS.templates}>
            <TemplatesSettings />
          </div>
        </StackedSections>
      )
    case 'shortcuts':
      return <ShortcutsSettings />
    case 'modules':
      return <FeaturesSection onConfigure={setActiveSection} />
    case 'ai':
      return (
        <AISettings
          // Remount so a new deep link (e.g. agent-providers) selects its tab.
          key={section}
          initialTab={
            section === 'agent-providers'
              ? 'agents'
              : section === 'agent-mcp' || section === 'command-line'
                ? 'connect'
                : 'models'
          }
          focusTarget={focusTarget}
          focusRequestId={focusRequestId}
        />
      )
    case 'tags':
      return (
        <StackedSections>
          <TagsSettings />
          <div id={SECTION_ANCHORS.properties}>
            <PropertiesSettings />
          </div>
        </StackedSections>
      )
    case 'vault':
      return <VaultSettings focusTarget={focusTarget} focusRequestId={focusRequestId} />
    case 'import':
      return <ImportSettings />
  }
}

function StackedSections({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-10">{children}</div>
}

function DrillInBar({
  parentLabel,
  currentLabel,
  onBack
}: {
  parentLabel: string
  currentLabel: string
  onBack: () => void
}) {
  const { t } = useT('settings')

  return (
    <div className="flex items-center gap-1.5 pb-4 text-xs/4 text-muted-foreground">
      <button
        type="button"
        onClick={onBack}
        aria-label={t('page.drillIn.back', { section: parentLabel })}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 -ms-1.5 hover:bg-sidebar-accent hover:text-foreground transition-colors"
      >
        <ChevronLeft className="w-3 h-3 rtl:rotate-180" />
        <span>{parentLabel}</span>
      </button>
      <span aria-hidden="true" className="text-muted-foreground/60">
        /
      </span>
      <span className="text-foreground">{currentLabel}</span>
      <kbd className="ms-auto font-mono text-[11px]/3.5 px-1.5 rounded border border-border">
        esc
      </kbd>
    </div>
  )
}

/**
 * Marks the row whose label matches the selected search result. Sections load
 * their data asynchronously, so wait for the row to mount before scrolling.
 */
function useSettingsSearchHighlight(
  containerRef: React.RefObject<HTMLDivElement | null>,
  label: string | null,
  section: SettingsSection
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container || !label) return

    let marked: Element | null = null
    const tryMark = (): boolean => {
      const match = Array.from(container.querySelectorAll(`[${SETTINGS_LABEL_ATTR}]`)).find(
        (el) => el.getAttribute(SETTINGS_LABEL_ATTR) === label
      )
      if (!match) return false
      marked = match
      match.setAttribute(SETTINGS_HIT_ATTR, '')
      // Optional call: jsdom does not implement scrollIntoView.
      match.scrollIntoView?.({ block: 'center' })
      return true
    }

    let observer: MutationObserver | null = null
    let timeout: ReturnType<typeof setTimeout> | undefined
    if (!tryMark()) {
      observer = new MutationObserver(() => {
        if (tryMark()) observer?.disconnect()
      })
      observer.observe(container, { childList: true, subtree: true })
      timeout = setTimeout(() => observer?.disconnect(), 3000)
    }

    return () => {
      observer?.disconnect()
      clearTimeout(timeout)
      marked?.removeAttribute(SETTINGS_HIT_ATTR)
    }
  }, [containerRef, label, section])
}

function focusHighlightedControl(container: HTMLElement | null) {
  const hit = container?.querySelector(`[${SETTINGS_HIT_ATTR}]`)
  const control = hit?.querySelector<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="switch"], [tabindex]:not([tabindex="-1"])'
  )
  control?.focus()
}

function SettingsSearchResults({
  results,
  selectedIndex,
  onSelect
}: {
  results: SettingsSearchResult[]
  selectedIndex: number
  onSelect: (index: number) => void
}) {
  const { t } = useT('settings')

  return (
    <div className="flex flex-col px-2.5 gap-px">
      <span className="px-2 pb-1.5 text-[11px]/3.5 font-medium text-muted-foreground" role="status">
        {results.length > 0
          ? t('page.search.count', { count: results.length })
          : t('page.search.empty')}
      </span>
      <div id="settings-search-results" role="listbox" className="flex flex-col gap-px">
        {results.map((result, index) => {
          const isSelected = index === selectedIndex
          return (
            <button
              key={result.entry.id}
              id={`settings-search-result-${index}`}
              type="button"
              role="option"
              aria-selected={isSelected}
              tabIndex={-1}
              // Keep focus in the search field so arrows and Enter keep working.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(index)}
              className={cn(
                'flex flex-col gap-px px-2 py-1.5 rounded-md text-start transition-colors',
                isSelected ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
              )}
            >
              <span
                className={cn(
                  'text-[13px]/4 truncate w-full',
                  isSelected ? 'font-medium text-foreground' : 'text-foreground/85'
                )}
              >
                {result.label}
              </span>
              <span className="text-[11px]/3.5 text-muted-foreground truncate w-full">
                {result.path}
              </span>
            </button>
          )
        })}
      </div>
      {results.length > 0 && (
        <div className="flex items-center gap-1.5 px-2 pt-3.5 text-[11px]/3.5 text-muted-foreground">
          <kbd className="font-mono px-1 rounded-[3px] border border-border">↑↓</kbd>
          <span>{t('page.search.move')}</span>
          <kbd className="font-mono px-1 rounded-[3px] border border-border">↵</kbd>
          <span>{t('page.search.open')}</span>
        </div>
      )}
    </div>
  )
}

function SettingsNavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col mt-4 px-2 gap-px">
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
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'relative flex items-center h-7 shrink-0 rounded-[5px] px-3 transition-colors',
        isActive
          ? 'bg-sidebar-accent text-foreground font-medium'
          : 'text-muted-foreground hover:bg-sidebar-accent'
      )}
    >
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="ps-2 text-[13px]/4 font-medium">{label}</span>
      {isActive && (
        <span className="absolute start-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-[var(--tint)] rounded-e-sm" />
      )}
    </button>
  )
}

export default SettingsPage
