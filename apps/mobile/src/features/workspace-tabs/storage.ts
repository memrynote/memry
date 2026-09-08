import type { VaultDb } from '@/db/index'
import {
  EMPTY_WORKSPACE_TABS,
  normalizeWorkspaceTabs,
  type WorkspaceTab,
  type WorkspaceTabsState
} from './model'

export const WORKSPACE_TABS_META_KEY = 'workspace.tabs.v1'
const STORAGE_VERSION = 1

export interface WorkspaceTabsStorage {
  load(): Promise<WorkspaceTabsState>
  save(state: WorkspaceTabsState): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseTab(value: unknown): WorkspaceTab | null {
  if (!isRecord(value) || !isRecord(value.destination)) return null
  if (value.destination.kind !== 'note') return null
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.destination.noteId !== 'string' ||
    value.destination.noteId.length === 0 ||
    typeof value.title !== 'string' ||
    !isTimestamp(value.openedAt) ||
    !isTimestamp(value.lastAccessedAt)
  )
    return null

  return {
    id: value.id,
    destination: { kind: 'note', noteId: value.destination.noteId },
    title: value.title,
    openedAt: value.openedAt,
    lastAccessedAt: value.lastAccessedAt
  }
}

/** Keep valid ids; deterministically re-key only later collisions. */
function uniqueTabIds(tabs: readonly WorkspaceTab[]): WorkspaceTab[] {
  const used = new Set<string>()
  return tabs.map((tab) => {
    if (!used.has(tab.id)) {
      used.add(tab.id)
      return tab
    }

    const base = `note:${tab.destination.noteId}`
    let id = base
    let suffix = 2
    while (used.has(id)) {
      id = `${base}:${suffix}`
      suffix += 1
    }
    used.add(id)
    return { ...tab, id }
  })
}

export function parseWorkspaceTabs(raw: string | null): WorkspaceTabsState {
  if (raw === null) return EMPTY_WORKSPACE_TABS
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return EMPTY_WORKSPACE_TABS
  }
  if (!isRecord(value) || value.version !== STORAGE_VERSION || !Array.isArray(value.tabs)) {
    return EMPTY_WORKSPACE_TABS
  }
  const tabs: WorkspaceTab[] = []
  for (const candidate of value.tabs) {
    const tab = parseTab(candidate)
    if (!tab) return EMPTY_WORKSPACE_TABS
    tabs.push(tab)
  }
  const activeTabId = typeof value.activeTabId === 'string' ? value.activeTabId : null
  return normalizeWorkspaceTabs(uniqueTabIds(tabs), activeTabId)
}

export function serializeWorkspaceTabs(state: WorkspaceTabsState): string {
  return JSON.stringify({ version: STORAGE_VERSION, ...state })
}

export function createWorkspaceTabsStorage(db: VaultDb): WorkspaceTabsStorage {
  return {
    async load() {
      const row = await db.getFirstAsync<{ value: string }>(
        'SELECT value FROM meta WHERE key = ?',
        [WORKSPACE_TABS_META_KEY]
      )
      return parseWorkspaceTabs(row?.value ?? null)
    },
    async save(state) {
      await db.runAsync(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [WORKSPACE_TABS_META_KEY, serializeWorkspaceTabs(state)]
      )
    }
  }
}
