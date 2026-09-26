import type { SettingsSection } from '@/contexts/settings-modal-context'
import { getSettingsPage, getSettingsParent, type SettingsPageId } from './settings-navigation'

/**
 * Searchable settings. Each entry points at an i18n label that the target
 * section renders through `SettingRow` / `SettingsGroup`, which tag their DOM
 * with `data-settings-label` so the hit can be scrolled to and highlighted.
 * Entries without a matching row still navigate to their section.
 */
export interface SettingsSearchEntry {
  id: string
  section: SettingsSection
  labelKey: string
  groupKey?: string
  /** Extra i18n keys searched but not displayed (descriptions, synonyms). */
  extraKeys?: string[]
  /** Group entries highlight the heading; page entries only navigate. */
  kind?: 'row' | 'group' | 'page'
}

type EntrySpec = [labelKey: string, extraKeys?: string[]]

function group(
  section: SettingsSection,
  groupKey: string,
  rows: EntrySpec[]
): SettingsSearchEntry[] {
  return [
    { id: `${section}:${groupKey}`, section, labelKey: groupKey, kind: 'group' },
    ...rows.map(([labelKey, extraKeys]) => ({
      id: `${section}:${labelKey}`,
      section,
      labelKey,
      groupKey,
      extraKeys
    }))
  ]
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  ...group('general', 'general.groups.languageRegion', [
    ['general.language.label'],
    ['general.clockFormat.label'],
    ['general.dateFormat.label']
  ]),
  ...group('general', 'general.groups.startupWindows', [
    ['general.startup.launchAtLogin.label'],
    ['general.tabs.restoreSession.label'],
    ['general.tabs.openPagesInNewTab.label'],
    ['general.tabs.closeButton.label'],
    ['general.window.minimizeToTray.label']
  ]),
  ...group('general', 'general.groups.newNotes', [
    ['general.fileCreation.defaultNoteFolder.label'],
    ['general.fileCreation.createInSelectedFolder.label']
  ]),
  ...group('general', 'general.groups.updates', [
    ['general.updates.label'],
    ['general.updates.autoCheck.label'],
    ['general.updates.autoDownload.label']
  ]),
  ...group('general', 'general.groups.privacy', [
    ['general.privacy.telemetry.label'],
    ['general.privacy.autoSendDiagnostics.label'],
    ['general.privacy.diagnostics.sendReport.label']
  ]),
  ...group('appearance', 'appearance.groups.theme', [
    ['appearance.v2.colorMode'],
    ['appearance.v2.accent'],
    ['appearance.v2.customColor']
  ]),
  ...group('appearance', 'appearance.v2.groups.text', [
    ['appearance.v2.fontFamily'],
    ['appearance.v2.fontSize'],
    ['appearance.v2.zoom']
  ]),
  ...group('editor', 'editor.groups.layout', [
    ['editor.v2.width', ['editor.width.description']],
    ['editor.v2.toolbarMode']
  ]),
  ...group('editor', 'editor.groups.spelling', [['editor.v2.spellCheck']]),
  ...group('journal', 'journal.v2.groups.defaultTemplate', [['journal.template.label']]),
  ...group('journal', 'journal.v2.groups.location', [
    ['journal.folder.label', ['journal.folder.description']],
    ['journal.dateFormat.label']
  ]),
  ...group('journal', 'journal.groups.footer', [['journal.showStatsFooter.label']]),
  ...group('tasks', 'tasks.groups.defaults', [
    ['tasks.defaultProject.label'],
    ['tasks.sortOrder.label'],
    ['tasks.defaultView.label']
  ]),
  ...group('tasks', 'tasks.groups.inbox', [['tasks.staleInbox.label']]),
  ...group('inbox', 'inbox.reviewReminder.group', [
    ['inbox.reviewReminder.enabled.label'],
    ['inbox.reviewReminder.time.label'],
    ['inbox.reviewReminder.test.label']
  ]),
  ...group('inbox', 'inbox.imageFiling.group', [
    ['inbox.imageFiling.mode.label'],
    ['inbox.imageFiling.ask.label']
  ]),
  ...group('calendar', 'calendar.v2.groups.layout', [
    ['calendar.weekStart.label'],
    ['calendar.defaultBehavior.label'],
    ['calendar.pageOverride.label'],
    ['calendar.showNotesOnCalendar.label']
  ]),
  ...group('account', 'account.groups.sync', [['account.sync.attachmentAutoDownload.label']]),
  {
    id: 'account:account.groups.billing',
    section: 'account',
    labelKey: 'account.groups.billing',
    kind: 'group'
  },
  {
    id: 'ai:ai.enable.label',
    section: 'ai',
    labelKey: 'ai.enable.label',
    extraKeys: ['ai.enable.description']
  },
  ...group('ai', 'ai.v2.inline.group', [
    ['ai.v2.inline.enabled', ['ai.inline.enableDescription']],
    ['ai.inline.model'],
    ['ai.inline.apiKey'],
    ['ai.inline.ollamaUrl']
  ]),
  ...group('ai', 'ai.v2.voice.group', [
    ['ai.v2.voice.transcribeWith'],
    ['ai.v2.voice.nameBy'],
    ['ai.voice.apiKey']
  ]),
  {
    id: 'agent-providers:access',
    section: 'agent-providers',
    labelKey: 'agentProviders.v2.permissions.access'
  },
  {
    id: 'agent-providers:changes',
    section: 'agent-providers',
    labelKey: 'agentProviders.v2.permissions.changes'
  },
  {
    id: 'command-line:defaultVault',
    section: 'command-line',
    labelKey: 'commandLine.defaultVault.label'
  },
  {
    id: 'vault:accountVaults',
    section: 'vault',
    labelKey: 'vault.groups.accountVaults',
    kind: 'group'
  },
  ...group('vault', 'vault.groups.activity', [['vault.activity.retention.label']]),
  {
    id: 'shortcuts:systemWide',
    section: 'shortcuts',
    labelKey: 'shortcuts.v2.systemWide',
    kind: 'group'
  },
  // Whole pages, so "templates" or "properties" land somewhere useful.
  ...(
    [
      ['account', 'page.nav.items.account'],
      ['general', 'page.nav.items.general'],
      ['appearance', 'page.nav.items.appearance'],
      ['editor', 'page.nav.items.editor'],
      ['templates', 'page.nav.items.templates'],
      ['shortcuts', 'page.nav.items.shortcuts'],
      ['features', 'page.nav.items.modules'],
      ['journal', 'page.nav.items.journal'],
      ['tasks', 'page.nav.items.tasks'],
      ['inbox', 'page.nav.items.inbox'],
      ['calendar', 'page.nav.items.calendar'],
      ['ai', 'page.nav.items.aiAgents'],
      ['agent-providers', 'agentProviders.header.title'],
      ['command-line', 'page.nav.items.commandLine'],
      ['tags', 'page.nav.items.tags'],
      ['properties', 'page.nav.items.properties'],
      ['vault', 'page.nav.items.vaultData'],
      ['import', 'page.nav.items.import']
    ] as const
  ).map(([section, labelKey]) => ({
    id: `page:${section}`,
    section,
    labelKey,
    kind: 'page' as const
  }))
]

const PAGE_LABEL_KEY: Record<SettingsPageId, string> = {
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

export interface SettingsSearchResult {
  entry: SettingsSearchEntry
  label: string
  /** Breadcrumb such as "Modules › Journal" or "General › Language & region". */
  path: string
}

type Translate = (key: string) => string

/** Lowercase, strip accents and punctuation so "up-date" matches "Update". */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function breadcrumb(entry: SettingsSearchEntry, t: Translate): string {
  const parts = [t(PAGE_LABEL_KEY[getSettingsPage(entry.section)])]
  if (getSettingsParent(entry.section)) parts.push(t(`page.nav.items.${entry.section}`))
  if (entry.groupKey) parts.push(t(entry.groupKey))
  return parts.join(' › ')
}

/**
 * Every query word must appear in the label, breadcrumb or extra text.
 * Ranked: label prefix, label word prefix, label substring, other text.
 */
export function searchSettings(query: string, t: Translate): SettingsSearchResult[] {
  const words = normalizeSearchText(query).split(' ').filter(Boolean)
  if (words.length === 0) return []
  const compactQuery = words.join('')

  const scored: Array<SettingsSearchResult & { score: number; order: number }> = []
  const seenLabels = new Set<string>()

  SETTINGS_SEARCH_INDEX.forEach((entry, order) => {
    const label = t(entry.labelKey)
    const path = breadcrumb(entry, t)
    const normLabel = normalizeSearchText(label)
    const haystack = normalizeSearchText(
      [label, path, ...(entry.extraKeys ?? []).map((key) => t(key))].join(' ')
    )
    const compactLabel = normLabel.replace(/ /g, '')
    const matches =
      words.every((word) => haystack.includes(word)) || compactLabel.includes(compactQuery)
    if (!matches) return

    // Page entries duplicate a row/group with the same text (e.g. "Updates").
    const dedupeKey = `${entry.section}:${normLabel}`
    if (seenLabels.has(dedupeKey)) return
    seenLabels.add(dedupeKey)

    const first = words[0]
    const score = normLabel.startsWith(first)
      ? 0
      : normLabel.split(' ').some((w) => w.startsWith(first))
        ? 1
        : normLabel.includes(first) || compactLabel.includes(compactQuery)
          ? 2
          : 3
    scored.push({ entry, label, path, score, order })
  })

  return scored
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map(({ entry, label, path }) => ({ entry, label, path }))
}

/** Attribute rows and group headings carry so search can find them in the DOM. */
export const SETTINGS_LABEL_ATTR = 'data-settings-label'
export const SETTINGS_HIT_ATTR = 'data-search-hit'
