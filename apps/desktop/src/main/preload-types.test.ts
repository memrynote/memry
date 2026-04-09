import type { InboxClientAPI, InboxItem } from '@memry/rpc/inbox'
import type { Note, NotesClientAPI } from '@memry/rpc/notes'
import type { Task, TasksClientAPI } from '@memry/rpc/tasks'
import { describe, expectTypeOf, it } from 'vitest'
import type {
  InboxClientAPI as PreloadInboxClientAPI,
  InboxItem as PreloadInboxItem,
  Note as PreloadNote,
  NotesClientAPI as PreloadNotesClientAPI,
  Task as PreloadTask,
  TasksClientAPI as PreloadTasksClientAPI
} from '../preload/index.d'

describe('preload type declarations', () => {
  it('exposes sync and crypto APIs on window.api', () => {
    expectTypeOf<Window['api']['syncAuth']['requestOtp']>().toBeFunction()
    expectTypeOf<Window['api']['syncSetup']['setupFirstDevice']>().toBeFunction()
    expectTypeOf<Window['api']['syncLinking']['generateLinkingQr']>().toBeFunction()
    expectTypeOf<Window['api']['syncDevices']['getDevices']>().toBeFunction()
    expectTypeOf<Window['api']['syncOps']['triggerSync']>().toBeFunction()
    expectTypeOf<Window['api']['crypto']['encryptItem']>().toBeFunction()
    expectTypeOf<Window['api']['syncAttachments']['upload']>().toBeFunction()
    expectTypeOf<Window['api']['onSyncStatusChanged']>().toBeFunction()
  })

  it('reuses canonical rpc note, task, and inbox types', () => {
    expectTypeOf<PreloadNote>().toEqualTypeOf<Note>()
    expectTypeOf<PreloadTask>().toEqualTypeOf<Task>()
    expectTypeOf<PreloadInboxItem>().toEqualTypeOf<InboxItem>()

    expectTypeOf<PreloadNotesClientAPI>().toEqualTypeOf<NotesClientAPI>()
    expectTypeOf<PreloadTasksClientAPI>().toEqualTypeOf<TasksClientAPI>()
    expectTypeOf<PreloadInboxClientAPI>().toEqualTypeOf<InboxClientAPI>()

    expectTypeOf<Window['api']['notes']>().toEqualTypeOf<NotesClientAPI>()
    expectTypeOf<Window['api']['tasks']>().toEqualTypeOf<TasksClientAPI>()
    expectTypeOf<Window['api']['inbox']>().toEqualTypeOf<InboxClientAPI>()
  })
})
