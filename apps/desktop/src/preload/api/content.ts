import {
  PropertiesChannels,
  TemplatesChannels,
  SavedFiltersChannels
} from '@memry/contracts/ipc-channels'
import { invoke, subscribe } from '../lib/ipc'
import type { MainIpcInvokeArgs } from '../../main/ipc/generated-ipc-invoke-map'

export const propertiesApi = {
  get: (entityId: string) => invoke(PropertiesChannels.invoke.GET, { entityId }),
  set: (entityId: string, properties: Record<string, unknown>) =>
    invoke(PropertiesChannels.invoke.SET, { entityId, properties }),
  rename: (entityId: string, oldName: string, newName: string) =>
    invoke(PropertiesChannels.invoke.RENAME, { entityId, oldName, newName })
}

type TemplateProperty = {
  name: string
  type: string
  value: unknown
  options?: string[]
}

type TemplateCreateInput = {
  name: string
  description?: string
  icon?: string | null
  tags?: string[]
  properties?: TemplateProperty[]
  content?: string
}

type TemplateUpdateInput = {
  id: string
  name?: string
  description?: string
  icon?: string | null
  tags?: string[]
  properties?: TemplateProperty[]
  content?: string
}

export const templatesApi = {
  list: () => invoke(TemplatesChannels.invoke.LIST),
  get: (id: string) => invoke(TemplatesChannels.invoke.GET, id),
  create: (input: TemplateCreateInput) =>
    invoke(
      TemplatesChannels.invoke.CREATE,
      input as MainIpcInvokeArgs<typeof TemplatesChannels.invoke.CREATE>[0]
    ),
  update: (input: TemplateUpdateInput) =>
    invoke(
      TemplatesChannels.invoke.UPDATE,
      input as MainIpcInvokeArgs<typeof TemplatesChannels.invoke.UPDATE>[0]
    ),
  delete: (id: string) => invoke(TemplatesChannels.invoke.DELETE, id),
  duplicate: (id: string, newName: string) =>
    invoke(TemplatesChannels.invoke.DUPLICATE, { id, newName })
}

export const savedFiltersApi = {
  list: () => invoke(SavedFiltersChannels.invoke.LIST),
  create: (input: { name: string; config: unknown }) =>
    invoke(
      SavedFiltersChannels.invoke.CREATE,
      input as MainIpcInvokeArgs<typeof SavedFiltersChannels.invoke.CREATE>[0]
    ),
  update: (input: { id: string; name?: string; config?: unknown; position?: number }) =>
    invoke(
      SavedFiltersChannels.invoke.UPDATE,
      input as MainIpcInvokeArgs<typeof SavedFiltersChannels.invoke.UPDATE>[0]
    ),
  delete: (id: string) => invoke(SavedFiltersChannels.invoke.DELETE, { id }),
  reorder: (ids: string[], positions: number[]) =>
    invoke(SavedFiltersChannels.invoke.REORDER, { ids, positions })
}

export const contentEvents = {
  onSavedFilterCreated: (callback: (event: { savedFilter: unknown }) => void): (() => void) =>
    subscribe<{ savedFilter: unknown }>(SavedFiltersChannels.events.CREATED, callback),

  onSavedFilterUpdated: (
    callback: (event: { id: string; savedFilter: unknown }) => void
  ): (() => void) =>
    subscribe<{ id: string; savedFilter: unknown }>(SavedFiltersChannels.events.UPDATED, callback),

  onSavedFilterDeleted: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(SavedFiltersChannels.events.DELETED, callback),

  onTemplateCreated: (callback: (event: { template: unknown }) => void): (() => void) =>
    subscribe<{ template: unknown }>(TemplatesChannels.events.CREATED, callback),

  onTemplateUpdated: (callback: (event: { id: string; template: unknown }) => void): (() => void) =>
    subscribe<{ id: string; template: unknown }>(TemplatesChannels.events.UPDATED, callback),

  onTemplateDeleted: (callback: (event: { id: string }) => void): (() => void) =>
    subscribe<{ id: string }>(TemplatesChannels.events.DELETED, callback)
}
