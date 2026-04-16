/**
 * IPC Channels Contract Tests
 *
 * Validates channel name constants and structural invariants:
 *  - each channel value is a non-empty string
 *  - every channel uses its namespace prefix (e.g. "vault:*")
 *  - no duplicate channel strings across all channel groups
 *  - well-known entries are present on the exported objects
 */

import { describe, it, expect } from 'vitest'
import {
  VaultChannels,
  NotesChannels,
  TagsChannels,
  TasksChannels,
  SavedFiltersChannels,
  TemplatesChannels,
  PropertiesChannels,
  JournalChannels,
  SettingsChannels,
  AccountChannels,
  DataChannels,
  BookmarksChannels,
  InboxChannels,
  CalendarChannels,
  ReminderChannels,
  SearchChannels,
  FolderViewChannels,
  GraphChannels
} from './ipc-channels'

type ChannelGroup = {
  readonly invoke?: Readonly<Record<string, string>>
  readonly events?: Readonly<Record<string, string>>
  readonly sync?: Readonly<Record<string, string>>
}

const ALL_GROUPS: Array<readonly [string, ChannelGroup]> = [
  ['VaultChannels', VaultChannels],
  ['NotesChannels', NotesChannels],
  ['TagsChannels', TagsChannels],
  ['TasksChannels', TasksChannels],
  ['SavedFiltersChannels', SavedFiltersChannels],
  ['TemplatesChannels', TemplatesChannels],
  ['PropertiesChannels', PropertiesChannels],
  ['JournalChannels', JournalChannels],
  ['SettingsChannels', SettingsChannels],
  ['AccountChannels', AccountChannels],
  ['DataChannels', DataChannels],
  ['BookmarksChannels', BookmarksChannels],
  ['InboxChannels', InboxChannels],
  ['CalendarChannels', CalendarChannels],
  ['ReminderChannels', ReminderChannels],
  ['SearchChannels', SearchChannels],
  ['FolderViewChannels', FolderViewChannels],
  ['GraphChannels', GraphChannels]
]

const GROUP_PREFIXES: Record<string, string> = {
  VaultChannels: 'vault:',
  NotesChannels: 'notes:',
  TagsChannels: 'tags:',
  TasksChannels: 'tasks:',
  SavedFiltersChannels: 'saved-filters:',
  TemplatesChannels: 'templates:',
  PropertiesChannels: 'properties:',
  JournalChannels: 'journal:',
  SettingsChannels: 'settings:',
  AccountChannels: 'account:',
  DataChannels: 'data:',
  BookmarksChannels: 'bookmarks:',
  InboxChannels: 'inbox:',
  CalendarChannels: 'calendar:',
  ReminderChannels: 'reminder:',
  SearchChannels: 'search:',
  FolderViewChannels: 'folder-view:',
  GraphChannels: 'graph:'
}

function collectChannels(group: ChannelGroup): string[] {
  const values: string[] = []
  for (const bucket of [group.invoke, group.events, group.sync]) {
    if (!bucket) continue
    for (const value of Object.values(bucket)) {
      values.push(value)
    }
  }
  return values
}

describe('IPC channel constants', () => {
  it.each(ALL_GROUPS)('%s has at least one channel', (_name, group) => {
    const channels = collectChannels(group)
    expect(channels.length).toBeGreaterThan(0)
  })

  it.each(ALL_GROUPS)('%s entries are non-empty strings', (_name, group) => {
    for (const channel of collectChannels(group)) {
      expect(typeof channel).toBe('string')
      expect(channel.length).toBeGreaterThan(0)
    }
  })

  it.each(ALL_GROUPS)('%s entries use their namespace prefix', (name, group) => {
    const prefix = GROUP_PREFIXES[name]
    for (const channel of collectChannels(group)) {
      expect(channel.startsWith(prefix)).toBe(true)
    }
  })

  it('has no duplicate channel strings across groups', () => {
    const seen = new Map<string, string>()
    const duplicates: Array<{ channel: string; firstGroup: string; secondGroup: string }> = []
    for (const [name, group] of ALL_GROUPS) {
      for (const channel of collectChannels(group)) {
        const existing = seen.get(channel)
        if (existing && existing !== name) {
          duplicates.push({ channel, firstGroup: existing, secondGroup: name })
        } else {
          seen.set(channel, name)
        }
      }
    }
    expect(duplicates).toEqual([])
  })
})

describe('VaultChannels', () => {
  it('exposes expected invoke channels', () => {
    expect(VaultChannels.invoke.SELECT).toBe('vault:select')
    expect(VaultChannels.invoke.CREATE).toBe('vault:create')
    expect(VaultChannels.invoke.REVEAL).toBe('vault:reveal')
  })

  it('exposes expected event channels', () => {
    expect(VaultChannels.events.STATUS_CHANGED).toBe('vault:status-changed')
    expect(VaultChannels.events.ERROR).toBe('vault:error')
  })
})

describe('NotesChannels', () => {
  it('exposes CRUD invoke channels', () => {
    expect(NotesChannels.invoke.CREATE).toBe('notes:create')
    expect(NotesChannels.invoke.UPDATE).toBe('notes:update')
    expect(NotesChannels.invoke.DELETE).toBe('notes:delete')
    expect(NotesChannels.invoke.LIST).toBe('notes:list')
  })

  it('exposes expected event channels', () => {
    expect(NotesChannels.events.CREATED).toBe('notes:created')
    expect(NotesChannels.events.UPDATED).toBe('notes:updated')
    expect(NotesChannels.events.DELETED).toBe('notes:deleted')
  })
})

describe('TasksChannels', () => {
  it('exposes task + project + status channels', () => {
    expect(TasksChannels.invoke.CREATE).toBe('tasks:create')
    expect(TasksChannels.invoke.PROJECT_CREATE).toBe('tasks:project-create')
    expect(TasksChannels.invoke.STATUS_CREATE).toBe('tasks:status-create')
  })

  it('exposes bulk operation channels', () => {
    expect(TasksChannels.invoke.BULK_COMPLETE).toBe('tasks:bulk-complete')
    expect(TasksChannels.invoke.BULK_DELETE).toBe('tasks:bulk-delete')
    expect(TasksChannels.invoke.BULK_MOVE).toBe('tasks:bulk-move')
  })
})

describe('SettingsChannels', () => {
  it('exposes invoke, sync, and events buckets', () => {
    expect(SettingsChannels.invoke.GET).toBe('settings:get')
    expect(SettingsChannels.sync.GET_STARTUP_THEME).toBe('settings:getStartupThemeSync')
    expect(SettingsChannels.events.CHANGED).toBe('settings:changed')
  })

  it('exposes per-group getters + setters', () => {
    expect(SettingsChannels.invoke.GET_GENERAL_SETTINGS).toBe('settings:getGeneralSettings')
    expect(SettingsChannels.invoke.SET_GENERAL_SETTINGS).toBe('settings:setGeneralSettings')
    expect(SettingsChannels.invoke.GET_EDITOR_SETTINGS).toBe('settings:getEditorSettings')
    expect(SettingsChannels.invoke.SET_EDITOR_SETTINGS).toBe('settings:setEditorSettings')
    expect(SettingsChannels.invoke.GET_SYNC_SETTINGS).toBe('settings:getSyncSettings')
    expect(SettingsChannels.invoke.SET_SYNC_SETTINGS).toBe('settings:setSyncSettings')
  })
})

describe('AccountChannels', () => {
  it('exposes auth-related channels', () => {
    expect(AccountChannels.invoke.GET_INFO).toBe('account:getInfo')
    expect(AccountChannels.invoke.SIGN_OUT).toBe('account:signOut')
    expect(AccountChannels.invoke.GET_RECOVERY_KEY).toBe('account:getRecoveryKey')
  })
})

describe('PropertiesChannels', () => {
  it('exposes get/set/rename invoke channels', () => {
    expect(PropertiesChannels.invoke.GET).toBe('properties:get')
    expect(PropertiesChannels.invoke.SET).toBe('properties:set')
    expect(PropertiesChannels.invoke.RENAME).toBe('properties:rename')
  })
})

describe('GraphChannels', () => {
  it('exposes graph data invoke channels', () => {
    expect(GraphChannels.invoke.GET_GRAPH_DATA).toBe('graph:get-graph-data')
    expect(GraphChannels.invoke.GET_LOCAL_GRAPH).toBe('graph:get-local-graph')
  })
})

describe('channel key casing', () => {
  it.each(ALL_GROUPS)('%s invoke keys are SCREAMING_SNAKE_CASE', (_name, group) => {
    if (!group.invoke) return
    for (const key of Object.keys(group.invoke)) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it.each(ALL_GROUPS)('%s event keys are SCREAMING_SNAKE_CASE', (_name, group) => {
    if (!group.events) return
    for (const key of Object.keys(group.events)) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })
})
