import type { InboxClientAPI, InboxSubscriptions } from './inbox'
import { inboxRpc } from './inbox'
import type { NotesClientAPI, NotesSubscriptions } from './notes'
import { notesRpc } from './notes'
import type { SettingsClientAPI, SettingsSubscriptions } from './settings'
import { settingsRpc } from './settings'
import type { TasksClientAPI, TasksSubscriptions } from './tasks'
import { tasksRpc } from './tasks'

export type { RpcDomainSpec, RpcMethodSpec, RpcEventSpec, RpcClient, RpcSubscriptions } from './schema'
export { defineDomain, defineEvent, defineMethod } from './schema'

export { notesRpc } from './notes'
export { tasksRpc } from './tasks'
export { inboxRpc } from './inbox'
export { settingsRpc } from './settings'

export type { NotesClientAPI, NotesSubscriptions } from './notes'
export type { TasksClientAPI, TasksSubscriptions } from './tasks'
export type { InboxClientAPI, InboxSubscriptions } from './inbox'
export type { SettingsClientAPI, SettingsSubscriptions } from './settings'

export const rpcDomains = [notesRpc, tasksRpc, inboxRpc, settingsRpc] as const

export interface GeneratedRpcApi
  extends NotesSubscriptions,
    TasksSubscriptions,
    InboxSubscriptions,
    SettingsSubscriptions {
  notes: NotesClientAPI
  tasks: TasksClientAPI
  inbox: InboxClientAPI
  settings: SettingsClientAPI
}
