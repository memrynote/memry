import { useEffect, useMemo, useState } from 'react'
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

const ICON = 'size-4'

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-primary'

/**
 * Settings navigation. Renders in the sidebar panel in place of the vault tree
 * while settings is open; the matching content renders in the workspace
 * (`SettingsContent`). Search lives here and marks rows over there through the
 * shared `contentRef`.
 */
export function SettingsNav() {
  const { activeSection, setActiveSection, close, contentRef } = useSettingsModal()
  const { t } = useT('settings')
  const activePage = getSettingsPage(activeSection)

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
      // Clearing the query consumes Escape; the settings view skips prevented
      // events, so it does not also leave settings.
      if (query) {
        event.preventDefault()
        setQuery('')
      }
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
    <nav
      aria-label={t('page.title')}
      data-testid="settings-nav"
      className="flex min-h-0 flex-1 flex-col text-xs/4"
    >
      <div className="flex shrink-0 flex-col gap-2.5 px-3 pt-1 pb-3">
        <div className="flex h-[30px] items-center gap-1">
          <button
            type="button"
            onClick={close}
            aria-label={t('page.backToApp')}
            title={t('page.backToApp')}
            className={cn(
              'flex size-[30px] shrink-0 items-center justify-center rounded-[7px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-primary',
              FOCUS_RING
            )}
          >
            <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
          </button>
          <h2 className="min-w-0 truncate text-[15px]/5 font-semibold text-sidebar-primary">
            {t('page.title')}
          </h2>
        </div>
        <label className="flex h-8 items-center gap-2 rounded-[7px] bg-sidebar-accent px-2.5 ring-sidebar-primary transition-shadow focus-within:ring-1">
          <Search className="size-3.5 shrink-0 text-sidebar-foreground" aria-hidden="true" />
          <input
            type="search"
            data-settings-search=""
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('page.search.placeholder')}
            aria-label={t('page.search.placeholder')}
            aria-controls="settings-search-results"
            aria-activedescendant={selected ? `settings-search-result-${selectedIndex}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-[13px]/4 text-sidebar-primary outline-none placeholder:text-sidebar-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <kbd className="rounded-[4px] bg-background px-1 font-mono text-[10px]/4.5 text-sidebar-foreground">
              esc
            </kbd>
          )}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-4 scrollbar-thin [scrollbar-gutter:stable]">
        {query ? (
          <SettingsSearchResults
            results={results}
            selectedIndex={selectedIndex}
            onSelect={(index) => selectResult(index)}
          />
        ) : (
          <>
            <div className="flex flex-col gap-px px-2">
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
      </div>
    </nav>
  )
}

/** The active settings page, in a centered reading column. */
export function SettingsContent() {
  const { activeSection, focusTarget, focusRequestId, setActiveSection, contentRef } =
    useSettingsModal()
  const { t } = useT('settings')
  const activePage = getSettingsPage(activeSection)
  const parent = getSettingsParent(activeSection)

  // Merged pages: jump to the anchor of the legacy section, or back to the top.
  useEffect(() => {
    const anchorId = SECTION_ANCHORS[activeSection]
    const target = (anchorId && document.getElementById(anchorId)) || contentRef.current
    // Optional call: jsdom does not implement scrollIntoView.
    target?.scrollIntoView?.({ block: 'start' })
  }, [activeSection, contentRef])

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <ScrollArea className="h-full">
        <div ref={contentRef} className="mx-auto max-w-[46rem] px-8 pt-12 pb-16">
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
    <div className="flex flex-col gap-px px-2">
      <span
        className="px-2.5 pb-1 text-xs/4 font-medium text-sidebar-section-heading"
        role="status"
      >
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
                'flex flex-col gap-px rounded-[7px] px-2.5 py-1.5 text-start transition-colors',
                isSelected ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'
              )}
            >
              <span
                className={cn(
                  'text-[13px]/4 truncate w-full',
                  isSelected ? 'font-medium text-sidebar-primary' : 'text-sidebar-foreground'
                )}
              >
                {result.label}
              </span>
              <span className="w-full truncate text-[11px]/3.5 text-sidebar-section-heading">
                {result.path}
              </span>
            </button>
          )
        })}
      </div>
      {results.length > 0 && (
        <div className="flex items-center gap-1.5 px-2.5 pt-3.5 text-[11px]/3.5 text-sidebar-section-heading">
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
    <div className="mt-4 flex flex-col gap-px px-2">
      <span className="px-2.5 pb-1 text-xs/4 font-medium text-sidebar-section-heading">
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
        'flex h-8 shrink-0 items-center gap-2.5 rounded-[7px] px-2.5 text-[13px]/4 transition-colors',
        isActive
          ? 'bg-sidebar-accent font-medium text-sidebar-primary'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-primary',
        FOCUS_RING
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}
