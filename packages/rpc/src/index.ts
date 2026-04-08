import type { InboxClientAPI, InboxSubscriptions } from './inbox.ts'
import { inboxRpc } from './inbox.ts'
import type { NotesClientAPI, NotesSubscriptions } from './notes.ts'
import { notesRpc } from './notes.ts'
import type { SettingsClientAPI, SettingsSubscriptions } from './settings.ts'
import { settingsRpc } from './settings.ts'
import type { TasksClientAPI, TasksSubscriptions } from './tasks.ts'
import { tasksRpc } from './tasks.ts'

export type { RpcDomainSpec, RpcMethodSpec, RpcEventSpec, RpcClient, RpcSubscriptions } from './schema.ts'
export { defineDomain, defineEvent, defineMethod } from './schema.ts'

export { notesRpc } from './notes.ts'
export { tasksRpc } from './tasks.ts'
export { inboxRpc } from './inbox.ts'
export { settingsRpc } from './settings.ts'

export type { NotesClientAPI, NotesSubscriptions } from './notes.ts'
export type { TasksClientAPI, TasksSubscriptions } from './tasks.ts'
export type { InboxClientAPI, InboxSubscriptions } from './inbox.ts'
export type { SettingsClientAPI, SettingsSubscriptions } from './settings.ts'

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
