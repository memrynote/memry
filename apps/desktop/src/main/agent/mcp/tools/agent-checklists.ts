/**
 * What the checkbox lines in an agent's write become.
 *
 * By default each checkbox line the agent adds is stored as a plain checkbox
 * (`- [ ] Check the log {check}`), so the editor never turns it into a task.
 * Agents create tasks with the task tools. With the owner's
 * `convertAgentChecklistsToTasks` setting on, the lines become tasks during
 * the write, the way an import converts them, and the reply names each task.
 *
 * Only lines the agent adds are touched. A line whose exact text the body held
 * before the write is the owner's, and stays byte for byte as it was.
 */

import type { AgentMcpDesktopApiRequest } from '@memry/contracts/agent-mcp-channels'
import type { PlainChecklistsOption } from '@memry/contracts/notes-api'

import {
  linesAlreadyIn,
  markAddedChecklistLinesPlain,
  markChecklistLinesPlain
} from '../../../import/_shared/checklist-tasks'
import {
  convertChecklistsToTasks,
  deleteImportedTasks,
  type CreatedChecklistTask
} from '../../../import/_shared/imported-note'
import { getEditorSettings } from '../../../settings/editor-settings'
import { readJournalEntry } from '../../../vault/journal'
import { getNoteById } from '../../../vault/notes'
import { getTemplate } from '../../../vault/templates'
import type { CreatedTasksReply } from './handles'

function agentChecklistsBecomeTasks(): boolean {
  return getEditorSettings().convertAgentChecklistsToTasks
}

type DesktopOperation = AgentMcpDesktopApiRequest['operation']

/** The body each desktop write held before, for the operations whose request carries one. */
const DESKTOP_BODY_WRITES: Partial<
  Record<DesktopOperation, (input: Record<string, unknown>) => Promise<string>>
> = {
  'notes.create': async () => '',
  'notes.update': async (input) =>
    typeof input.id === 'string' ? ((await getNoteById(input.id))?.content ?? '') : '',
  'journal.createEntry': async () => '',
  'journal.updateEntry': async (input) =>
    typeof input.date === 'string' ? ((await readJournalEntry(input.date))?.content ?? '') : '',
  'templates.create': async () => '',
  'templates.update': async (input) =>
    typeof input.id === 'string' ? ((await getTemplate(input.id))?.content ?? '') : ''
}

/**
 * The writes whose body main builds from stored data (a template, an inbox
 * item, a file on disk), with the option that tells the owner whether to mark
 * the checkbox lines it adds. The option is always replaced, so an agent cannot
 * choose for the owner.
 */
const DESKTOP_BUILT_BODIES: Partial<
  Record<DesktopOperation, (args: unknown[], option: PlainChecklistsOption) => unknown[]>
> = {
  'notes.applyTemplate': ([input, ...rest], option) => [
    { ...(input as Record<string, unknown>), ...option },
    ...rest
  ],
  'inbox.convertToNote': ([itemId], option) => [itemId, option],
  'notes.importFiles': ([sourcePaths, targetFolder], option) => [sourcePaths, targetFolder, option]
}

/**
 * The plain-checkbox half alone, for desktop API writes. They run in the
 * renderer and reply with the operation's own result, so with the setting on
 * the lines are left for the editor to convert.
 */
export async function withAgentChecklists<R extends AgentMcpDesktopApiRequest>(
  request: R
): Promise<R> {
  const withOption = DESKTOP_BUILT_BODIES[request.operation]
  if (withOption) {
    const option = { plainChecklists: !agentChecklistsBecomeTasks() }
    return { ...request, args: withOption(request.args, option) }
  }

  const previousBody = DESKTOP_BODY_WRITES[request.operation]
  const [input, ...rest] = request.args
  if (!previousBody || !input || typeof input !== 'object') return request
  const fields = input as Record<string, unknown>
  if (typeof fields.content !== 'string' || agentChecklistsBecomeTasks()) return request

  const content = markAddedChecklistLinesPlain(fields.content, await previousBody(fields))
  return { ...request, args: [{ ...fields, content }, ...rest] }
}

interface AgentBodyWrite<T> {
  result: T
  createdTasks: CreatedChecklistTask[]
}

/**
 * Runs `write` with the agent's body after its checkbox lines are handled.
 * Tasks created for a write that then fails are deleted again, since they
 * would link to a body that was never stored.
 */
export async function writeAgentBody<T>(
  noteId: string,
  markdown: string,
  previous: string,
  write: (markdown: string) => Promise<T>
): Promise<AgentBodyWrite<T>> {
  const keepLine = linesAlreadyIn(markdown, previous)
  if (!agentChecklistsBecomeTasks()) {
    return { result: await write(markChecklistLinesPlain(markdown, keepLine)), createdTasks: [] }
  }

  const converted = await convertChecklistsToTasks(noteId, markdown, keepLine)
  try {
    return { result: await write(converted.markdown), createdTasks: converted.created }
  } catch (error) {
    await deleteImportedTasks(noteId, converted.created)
    throw error
  }
}

/** The reply field naming the tasks a write created. Absent when it created none. */
export function createdTasksReply(createdTasks: CreatedChecklistTask[]): CreatedTasksReply {
  return createdTasks.length > 0 ? { created_tasks: createdTasks } : {}
}
