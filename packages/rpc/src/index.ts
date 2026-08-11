import type { CalendarClientAPI, CalendarSubscriptions } from './calendar.ts'
import { calendarRpc } from './calendar.ts'
import type { CanvasClientAPI, CanvasSubscriptions } from './canvas.ts'
import { canvasRpc } from './canvas.ts'
import type { CanvasFolderClientAPI, CanvasFolderSubscriptions } from './canvas-folder.ts'
import { canvasFolderRpc } from './canvas-folder.ts'
import type { DiagnosticsClientAPI } from './diagnostics.ts'
import { diagnosticsRpc } from './diagnostics.ts'
import type { FeedbackClientAPI } from './feedback.ts'
import { feedbackRpc } from './feedback.ts'
import type { InboxClientAPI, InboxSubscriptions } from './inbox.ts'
import { inboxRpc } from './inbox.ts'
import type { NotesClientAPI, NotesSubscriptions } from './notes.ts'
import { notesRpc } from './notes.ts'
import type { SettingsClientAPI, SettingsSubscriptions } from './settings.ts'
import { settingsRpc } from './settings.ts'
import type { TasksClientAPI, TasksSubscriptions } from './tasks.ts'
import { tasksRpc } from './tasks.ts'
import type { TelemetryClientAPI } from './telemetry.ts'
import { telemetryRpc } from './telemetry.ts'

export type {
  RpcDomainSpec,
  RpcMethodSpec,
  RpcEventSpec,
  RpcClient,
  RpcSubscriptions
} from './schema.ts'
export { defineDomain, defineEvent, defineMethod } from './schema.ts'

export { notesRpc } from './notes.ts'
export { tasksRpc } from './tasks.ts'
export { inboxRpc } from './inbox.ts'
export { settingsRpc } from './settings.ts'
export { calendarRpc } from './calendar.ts'
export { canvasRpc } from './canvas.ts'
export { canvasFolderRpc } from './canvas-folder.ts'
export { telemetryRpc } from './telemetry.ts'
export { feedbackRpc } from './feedback.ts'
export { diagnosticsRpc } from './diagnostics.ts'

export type { NotesClientAPI, NotesSubscriptions } from './notes.ts'
export type { TasksClientAPI, TasksSubscriptions } from './tasks.ts'
export type { InboxClientAPI, InboxSubscriptions } from './inbox.ts'
export type { SettingsClientAPI, SettingsSubscriptions } from './settings.ts'
export type { CalendarClientAPI, CalendarSubscriptions } from './calendar.ts'
export type { CanvasClientAPI, CanvasSubscriptions } from './canvas.ts'
export type { CanvasFolderClientAPI, CanvasFolderSubscriptions } from './canvas-folder.ts'
export type { TelemetryClientAPI, TelemetrySettings } from './telemetry.ts'
export type { FeedbackClientAPI } from './feedback.ts'
export type { DiagnosticsClientAPI } from './diagnostics.ts'

export const rpcDomains = [
  notesRpc,
  tasksRpc,
  inboxRpc,
  settingsRpc,
  calendarRpc,
  canvasRpc,
  canvasFolderRpc,
  telemetryRpc,
  feedbackRpc,
  diagnosticsRpc
] as const

export interface GeneratedRpcApi
  extends
    NotesSubscriptions,
    TasksSubscriptions,
    InboxSubscriptions,
    SettingsSubscriptions,
    CalendarSubscriptions,
    CanvasSubscriptions,
    CanvasFolderSubscriptions {
  notes: NotesClientAPI
  tasks: TasksClientAPI
  inbox: InboxClientAPI
  settings: SettingsClientAPI
  calendar: CalendarClientAPI
  canvas: CanvasClientAPI
  canvasFolder: CanvasFolderClientAPI
  telemetry: TelemetryClientAPI
  feedback: FeedbackClientAPI
  diagnostics: DiagnosticsClientAPI
}
