import { useEffect, useState } from 'react'

import type { PreviewDiffRequest, PreviewDiffResponse } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAgentOptional } from './agent-context'

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

export function DiffModal(): React.JSX.Element | null {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const pending = agent?.state.pendingApprovals.find((approval) => approval.requiresDiff)
  const [preview, setPreview] = useState<PreviewDiffResponse | null>(null)
  const [candidate, setCandidate] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pending) return

    let cancelled = false
    setPreview(null)
    setCandidate('')
    setError(null)

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
  }, [pending?.conversationId, pending?.toolCallId, t])

  if (!agent || !pending) return null

  const currentAgent = agent
  const currentPending = pending

  function deny(): void {
    void currentAgent.approveTool({
      conversationId: currentPending.conversationId,
      toolCallId: currentPending.toolCallId,
      decision: { kind: 'deny' }
    })
  }

  function applyOriginal(): void {
    void currentAgent.approveTool({
      conversationId: currentPending.conversationId,
      toolCallId: currentPending.toolCallId,
      decision: { kind: 'allow' }
    })
  }

  function applyEdited(): void {
    void currentAgent.approveTool({
      conversationId: currentPending.conversationId,
      toolCallId: currentPending.toolCallId,
      decision: {
        kind: 'edit_allow',
        editedArgs: editedArgsWithCandidate(currentPending.args, candidate)
      }
    })
  }

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) deny()
      }}
    >
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t('agentChat.diff.title')}</DialogTitle>
          <DialogDescription>
            {t('agentChat.diff.description', {
              title: preview?.title ?? t('agentChat.diff.fallbackTitle')
            })}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <h3 className="text-sm font-medium">{t('agentChat.diff.current')}</h3>
              <pre className="h-72 overflow-auto rounded-md border border-border bg-muted p-3 text-xs">
                {preview?.current ?? t('agentChat.diff.loading')}
              </pre>
            </div>
            <div className="min-w-0 space-y-2">
              <h3 className="text-sm font-medium">{t('agentChat.diff.candidate')}</h3>
              <Textarea
                aria-label={t('agentChat.diff.candidate')}
                value={candidate}
                onChange={(event) => setCandidate(event.target.value)}
                disabled={!preview}
                className="h-72 resize-none font-mono text-xs"
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={deny}>
            {t('agentChat.approval.deny')}
          </Button>
          <Button type="button" variant="secondary" disabled={!preview} onClick={applyOriginal}>
            {t('agentChat.diff.apply')}
          </Button>
          <Button type="button" disabled={!preview} onClick={applyEdited}>
            {t('agentChat.diff.applyEdited')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
