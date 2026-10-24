import type { SettingsSection } from '@/contexts/settings-modal-context'

/**
 * Settings is organised as a small set of pages. Legacy `SettingsSection`
 * values (used by `openSettings('journal')`, deep links, quick capture, etc.)
 * stay valid: each one resolves to a page, and optionally to a drill-in
 * sub-page with a parent section to return to.
 */
export type SettingsPageId =
  | 'account'
  | 'general'
  | 'appearance'
  | 'editor'
  | 'shortcuts'
  | 'modules'
  | 'ai'
  | 'tags'
  | 'vault'
  | 'import'

export type SettingsDrillIn = 'journal' | 'tasks' | 'inbox' | 'calendar'

interface SectionLocation {
  page: SettingsPageId
  /** Set when the section renders as a drill-in sub-page. */
  parent?: SettingsSection
}

const SECTION_LOCATION: Record<SettingsSection, SectionLocation> = {
  account: { page: 'account' },
  general: { page: 'general' },
  appearance: { page: 'appearance' },
  editor: { page: 'editor' },
  templates: { page: 'editor' },
  shortcuts: { page: 'shortcuts' },
  features: { page: 'modules' },
  journal: { page: 'modules', parent: 'features' },
  tasks: { page: 'modules', parent: 'features' },
  inbox: { page: 'modules', parent: 'features' },
  calendar: { page: 'modules', parent: 'features' },
  ai: { page: 'ai' },
  'agent-providers': { page: 'ai' },
  'agent-mcp': { page: 'ai' },
  'command-line': { page: 'ai' },
  tags: { page: 'tags' },
  properties: { page: 'tags' },
  vault: { page: 'vault' },
  import: { page: 'import' }
}

/** Section a page's nav item opens. */
export const PAGE_ROOT_SECTION: Record<SettingsPageId, SettingsSection> = {
  account: 'account',
  general: 'general',
  appearance: 'appearance',
  editor: 'editor',
  shortcuts: 'shortcuts',
  modules: 'features',
  ai: 'ai',
  tags: 'tags',
  vault: 'vault',
  import: 'import'
}

export function getSettingsPage(section: SettingsSection): SettingsPageId {
  return SECTION_LOCATION[section]?.page ?? 'account'
}

/** Parent section for drill-in sub-pages; `null` for top-level pages. */
export function getSettingsParent(section: SettingsSection): SettingsSection | null {
  return SECTION_LOCATION[section]?.parent ?? null
}

/**
 * Sections that live further down a merged page. Opening one scrolls to its
 * anchor instead of the top of the page.
 */
export const SECTION_ANCHORS: Partial<Record<SettingsSection, string>> = {
  templates: 'settings-anchor-templates',
  'command-line': 'settings-anchor-command-line',
  properties: 'settings-anchor-properties'
}
