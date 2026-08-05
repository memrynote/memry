import { useEffect, useState } from 'react'

import type {
  ApproveToolDecision,
  Message,
  PreviewDiffRequest,
  PreviewDiffResponse
} from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationTitle
} from '@/components/ai-elements/confirmation'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  ToolText
} from '@/components/ai-elements/tool'
import { Textarea } from '@/components/ui/textarea'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAgentOptional } from '../agent-context'
import type { PendingToolApproval } from '../agent-context.reducer'

const updateToolNames = new Set(['vault_move_to_folder', 'vault_add_tag', 'vault_remove_tag'])

function isUpdateTool(name: string): boolean {
  return name.startsWith('vault_update_') || updateToolNames.has(name)
}

const toolLabels: Record<string, string> = {
  vault_search_notes: 'Searching notes',
  vault_read_note: 'Reading note',
  vault_list_folder: 'Reading folder',
  vault_get_current_note: 'Reading current note',
  vault_list_tasks: 'Reading tasks',
  vault_get_task: 'Reading task',
  vault_list_projects: 'Reading projects',
  vault_get_project: 'Reading project',
  vault_list_statuses: 'Reading statuses',
  vault_get_journal_entry: 'Reading journal',
  vault_list_journal_entries: 'Reading journals',
  vault_list_inbox_items: 'Reading inbox',
  vault_get_inbox_item: 'Reading inbox item',
  vault_get_tags: 'Reading tags',
  vault_desktop_read: 'Reading app data',
  vault_create_note: 'Creating note',
  vault_rename_note: 'Renaming note',
  vault_delete_note: 'Deleting note',
  vault_create_folder: 'Creating folder',
  vault_rename_folder: 'Renaming folder',
  vault_delete_folder: 'Deleting folder',
  vault_create_task: 'Creating task',
  vault_delete_task: 'Deleting task',
  vault_complete_task: 'Completing task',
  vault_uncomplete_task: 'Reopening task',
  vault_archive_task: 'Archiving task',
  vault_unarchive_task: 'Restoring task',
  vault_move_task: 'Moving task',
  vault_reorder_tasks: 'Reordering tasks',
  vault_duplicate_task: 'Duplicating task',
  vault_convert_task_to_subtask: 'Converting task',
  vault_convert_subtask_to_task: 'Converting subtask',
  vault_create_project: 'Creating project',
  vault_update_project: 'Updating project',
  vault_delete_project: 'Deleting project',
  vault_archive_project: 'Archiving project',
  vault_reorder_projects: 'Reordering projects',
  vault_create_status: 'Creating status',
  vault_update_status: 'Updating status',
  vault_delete_status: 'Deleting status',
  vault_reorder_statuses: 'Reordering statuses',
  vault_create_journal_entry: 'Creating journal',
  vault_update_journal_entry: 'Updating journal',
  vault_delete_journal_entry: 'Deleting journal',
  vault_add_to_inbox: 'Adding to inbox',
  vault_update_inbox_item: 'Updating inbox item',
  vault_snooze_inbox_item: 'Snoozing inbox item',
  vault_archive_inbox_item: 'Archiving inbox item',
  vault_unarchive_inbox_item: 'Restoring inbox item',
  vault_delete_inbox_item: 'Deleting inbox item',
  vault_add_inbox_tag: 'Adding inbox tag',
  vault_remove_inbox_tag: 'Removing inbox tag',
  vault_update_note: 'Updating note',
  vault_update_task: 'Updating task',
  vault_add_tag: 'Adding tag',
  vault_remove_tag: 'Removing tag',
  vault_move_to_folder: 'Moving note',
  vault_desktop_write: 'Updating app data'
}

function formatArgs(args: unknown): string {
  return JSON.stringify(args, null, 2)
}

function normalizeToolName(name: string): string {
  if (name.startsWith('mcp__memry__')) return name.slice('mcp__memry__'.length)
  if (name.startsWith('mcp_memry_')) return name.slice('mcp_memry_'.length)
  return name
}

function getDesktopToolLabel(tool: string, args: unknown): string | null {
  if (tool !== 'vault_desktop_read' && tool !== 'vault_desktop_write') return null
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null

  const operation = (args as { operation?: unknown }).operation
  if (typeof operation !== 'string') return null
  if (operation.startsWith('calendar.')) {
    return tool === 'vault_desktop_read' ? 'Checking calendar' : 'Updating calendar'
  }
  if (operation.startsWith('notes.')) return 'Reading notes'
  if (operation.startsWith('tasks.')) return 'Reading tasks'
  if (operation.startsWith('inbox.')) return 'Reading inbox'

  return null
}

export function humanizeToolName(name: string, args: unknown): string {
  const normalized = normalizeToolName(name)
  const desktopLabel = getDesktopToolLabel(normalized, args)
  if (desktopLabel) return desktopLabel

  const label = toolLabels[normalized]
  if (label) return label

  return normalized
    .replace(/^vault_/, '')
    .split('_')
    .filter(Boolean)
    .join(' ')
    .replace(/^\w/, (letter) => letter.toUpperCase())
}

interface AgentDiffApi {
  previewDiff: (input: PreviewDiffRequest) => Promise<PreviewDiffResponse>
}

function getAgentDiffApi(): AgentDiffApi {
  return (window.api as typeof window.api & { agent: AgentDiffApi }).agent
}

function editedArgsWithCandidate(args: unknown, candidate: string): Record<string, unknown> {
  const base = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  return {
    ...base,
    mode: 'replace',
    content_markdown: candidate
  }
}

function InlineDiffApproval({
  agent,
  pending
}: {
  agent: NonNullable<ReturnType<typeof useAgentOptional>>
  pending: PendingToolApproval
}): React.JSX.Element {
  const { t } = useT('common')
  const [preview, setPreview] = useState<PreviewDiffResponse | null>(null)
  const [candidate, setCandidate] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void getAgentDiffApi()
      .previewDiff({
        conversationId: pending.conversationId,
        toolCallId: pending.toolCallId
      })
      .then((result) => {
        if (cancelled) return
        setPreview(result)
        setCandidate(result.candidate)
      })
      .catch((err) => {
        if (!cancelled) setError(extractErrorMessage(err, t('agentChat.diff.previewError')))
      })

    return () => {
      cancelled = true
    }
  }, [pending.conversationId, pending.toolCallId, t])

  function deny(): void {
    void agent.approveTool({
      conversationId: pending.conversationId,
      toolCallId: pending.toolCallId,
      decision: { kind: 'deny' }
    })
  }

  function applyOriginal(): void {
    void agent.approveTool({
      conversationId: pending.conversationId,
      toolCallId: pending.toolCallId,
      decision: { kind: 'allow' }
    })
  }

  function applyEdited(): void {
    void agent.approveTool({
      conversationId: pending.conversationId,
      toolCallId: pending.toolCallId,
      decision: {
        kind: 'edit_allow',
        editedArgs: editedArgsWithCandidate(pending.args, candidate)
      }
    })
  }

  return (
    <Confirmation state="pending">
      <ConfirmationTitle>
        {t('agentChat.diff.description', {
          title: preview?.title ?? t('agentChat.diff.fallbackTitle')
        })}
      </ConfirmationTitle>
      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <h4 className="text-sm font-medium">{t('agentChat.diff.current')}</h4>
            <pre className="h-52 overflow-auto rounded-md border border-border bg-muted p-3 text-xs">
              {preview?.current ?? t('agentChat.diff.loading')}
            </pre>
          </div>
          <div className="min-w-0 space-y-2">
            <h4 className="text-sm font-medium">{t('agentChat.diff.candidate')}</h4>
            <Textarea
              aria-label={t('agentChat.diff.candidate')}
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
              disabled={!preview}
              className="h-52 resize-none font-mono text-xs"
            />
          </div>
        </div>
      )}
      <ConfirmationActions>
        <ConfirmationAction variant="secondary" onClick={deny}>
          {t('agentChat.approval.deny')}
        </ConfirmationAction>
        <ConfirmationAction variant="secondary" disabled={!preview} onClick={applyOriginal}>
          {t('agentChat.diff.apply')}
        </ConfirmationAction>
        <ConfirmationAction disabled={!preview} onClick={applyEdited}>
          {t('agentChat.diff.applyEdited')}
        </ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  )
}

export function ToolCallMessage({ message }: { message: Message }): React.JSX.Element | null {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const pending = agent?.state.pendingApprovals.find(
    (approval) => approval.toolCallId === message.toolCallId
  )
  const [editing, setEditing] = useState(false)
  const [edited, setEdited] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)

  if (message.content.role !== 'tool_call') return null

  const updateTool = pending ? isUpdateTool(pending.name) : false
  const approvalLabel = updateTool
    ? t('agentChat.approval.applyOnce')
    : t('agentChat.approval.allowOnce')
  const editLabel = updateTool
    ? t('agentChat.approval.editAndApply')
    : t('agentChat.approval.editAndAllow')

  function startEditing(): void {
    if (!pending) return
    setEditing(true)
    setEdited(formatArgs(pending.args))
    setParseError(null)
  }

  async function respond(decision: ApproveToolDecision): Promise<void> {
    if (!agent || !pending) return
    setParseError(null)
    await agent.approveTool({
      conversationId: pending.conversationId,
      toolCallId: pending.toolCallId,
      decision
    })
    setEditing(false)
    setEdited('')
  }

  function submitEditedArgs(): void {
    try {
      void respond({ kind: 'edit_allow', editedArgs: JSON.parse(edited) })
    } catch {
      setParseError(t('agentChat.approval.invalidJson'))
    }
  }

  const errorText = message.content.data.error?.message
  const toolLabel = humanizeToolName(message.content.data.tool, message.content.data.args)

  return (
    <Tool defaultOpen={false}>
      <ToolHeader title={toolLabel} state={message.content.data.status} />
      <ToolContent>
        <ToolText value={message.content.data.tool} />
        <ToolInput input={message.content.data.args} label={t('agentChat.toolCall.parameters')} />
        <ToolOutput errorText={errorText} output={message.content.data.output} />
        {agent && pending?.requiresDiff && (
          <InlineDiffApproval key={pending.toolCallId} agent={agent} pending={pending} />
        )}
        {pending && !pending.requiresDiff && (
          <Confirmation state={message.content.data.status}>
            <ConfirmationTitle>
              {t('agentChat.approval.description', { name: pending.name })}
            </ConfirmationTitle>
            {editing && (
              <div className="space-y-2">
                <Textarea
                  aria-label={t('agentChat.toolCall.editedArgs')}
                  value={edited}
                  onChange={(event) => {
                    setEdited(event.target.value)
                    setParseError(null)
                  }}
                  rows={8}
                  className="font-mono text-xs"
                />
                {parseError && <p className="text-xs text-destructive">{parseError}</p>}
              </div>
            )}
            <ConfirmationActions>
              <ConfirmationAction onClick={() => void respond({ kind: 'allow' })}>
                {approvalLabel}
              </ConfirmationAction>
              {!updateTool && (
                <ConfirmationAction
                  variant="secondary"
                  onClick={() => void respond({ kind: 'allow_always' })}
                >
                  {t('agentChat.approval.allowAlways')}
                </ConfirmationAction>
              )}
              <ConfirmationAction
                variant="secondary"
                onClick={editing ? submitEditedArgs : startEditing}
              >
                {editing ? t('agentChat.approval.applyEdits') : editLabel}
              </ConfirmationAction>
              <ConfirmationAction
                variant="destructive"
                onClick={() => void respond({ kind: 'deny' })}
              >
                {t('agentChat.approval.deny')}
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        )}
      </ToolContent>
    </Tool>
  )
}
