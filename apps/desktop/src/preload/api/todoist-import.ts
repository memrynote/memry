import { TodoistImportChannels } from '@memry/contracts/ipc-channels'
import type {
  TodoistImportRunInput,
  TodoistImportSummary,
  TodoistPreviewResponse
} from '@memry/contracts/todoist-import-api'
import { invoke } from '../lib/ipc'

export const todoistImportApi = {
  preview: (): Promise<TodoistPreviewResponse> =>
    invoke<TodoistPreviewResponse>(TodoistImportChannels.invoke.PREVIEW),
  run: (input: TodoistImportRunInput): Promise<TodoistImportSummary> =>
    invoke<TodoistImportSummary>(TodoistImportChannels.invoke.RUN, input)
}
