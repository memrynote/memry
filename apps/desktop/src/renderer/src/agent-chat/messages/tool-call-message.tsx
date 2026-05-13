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
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Textarea } from '@/components/ui/textarea'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAgentOptional } from '../agent-context'
import type { PendingToolApproval } from '../agent-context.reducer'

const updateToolNames = new Set(['vault_move_to_folder', 'vault_add_tag', 'vault_remove_tag'])

function isUpdateTool(name: string): boolean {
  return name.startsWith('vault_update_') || updateToolNames.has(name)
}

function formatArgs(args: unknown): string {
  return JSON.stringify(args, null, 2)
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

  return (
    <Tool defaultOpen={false}>
      <ToolHeader title={message.content.data.tool} state={message.content.data.status} />
      <ToolContent>
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
