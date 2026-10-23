import { Fragment, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { FoldAgentChoice, FoldAgentStatus } from '@memry/contracts/note-fold'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  SettingRow,
  ACCENT_SWITCH,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:Settings:AI')

/** Product names, not translated. */
const AGENT_LABELS: Record<Exclude<FoldAgentChoice, 'auto'>, string> = {
  claude_cli: 'Claude',
  codex_cli: 'Codex',
  antigravity_cli: 'Antigravity',
  local_openai_compatible: 'Local model'
}

interface SummarizeLongNotesRowProps {
  checked: boolean
  onSaved: (value: boolean) => void
  agent: FoldAgentChoice
  onAgentSaved: (value: FoldAgentChoice) => void
  /** Switches the AI settings to the Agents tab. */
  onOpenAgents: () => void
  /** Changes when the user may have connected an agent (the active AI tab); re-reads the status. */
  refreshKey: string
}

export function SummarizeLongNotesRow({
  checked,
  onSaved,
  agent,
  onAgentSaved,
  onOpenAgents,
  refreshKey
}: SummarizeLongNotesRowProps) {
  const { t } = useT('settings')
  const [failed, setFailed] = useState(false)
  const [agentStatus, setAgentStatus] = useState<FoldAgentStatus | null>(null)

  const refreshAgentStatus = useCallback(async () => {
    try {
      setAgentStatus(await window.api.noteFold.getAgentStatus())
    } catch (error) {
      log.error('Failed to read the fold agent status', error)
    }
  }, [])

  useEffect(() => {
    if (checked) void refreshAgentStatus()
  }, [checked, agent, refreshKey, refreshAgentStatus])

  const refreshLastRun = useCallback(async () => {
    try {
      const run = await window.api.noteFold.getLastRun()
      setFailed(run.status === 'failed')
    } catch (error) {
      log.error('Failed to read the last fold run', error)
    }
  }, [])

  useEffect(() => {
    if (!checked) return
    void refreshLastRun()
    return window.api.noteFold.onUpdated(() => void refreshLastRun())
  }, [checked, refreshLastRun])

  const handleRetry = useCallback(async () => {
    try {
      await window.api.noteFold.retry()
      await refreshLastRun()
    } catch (error) {
      toast.error(extractErrorMessage(error, t('ai.summarizeLongNotes.retryError')))
    }
  }, [refreshLastRun, t])

  const handleChange = useCallback(
    async (summarizeLongNotes: boolean) => {
      try {
        const result = await window.api.settings.setAISettings({ summarizeLongNotes })
        if (result.success) {
          onSaved(summarizeLongNotes)
        } else {
          toast.error(extractErrorMessage(result.error, t('ai.summarizeLongNotes.error')))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('ai.summarizeLongNotes.error')))
      }
    },
    [onSaved, t]
  )

  const handleAgentChange = useCallback(
    async (summarizeAgent: FoldAgentChoice) => {
      try {
        const result = await window.api.settings.setAISettings({ summarizeAgent })
        if (result.success) {
          onAgentSaved(summarizeAgent)
        } else {
          toast.error(extractErrorMessage(result.error, t('ai.summarizeLongNotes.agentError')))
        }
      } catch (error) {
        toast.error(extractErrorMessage(error, t('ai.summarizeLongNotes.agentError')))
      }
    },
    [onAgentSaved, t]
  )

  const agentOptions: FoldAgentChoice[] = [
    'auto',
    ...(agentStatus?.available.map((a) => a.id) ?? []),
    // A chosen agent that is no longer detected stays visible so the select shows the truth.
    ...(agent !== 'auto' && !agentStatus?.available.some((a) => a.id === agent) ? [agent] : [])
  ]

  return (
    <Fragment>
      <SettingRow
        label={t('ai.summarizeLongNotes.label')}
        description={t('ai.summarizeLongNotes.description')}
      >
        <div className="flex items-center">
          {checked && failed && (
            <span className="me-3 text-xs text-text-secondary">
              {t('ai.summarizeLongNotes.failed')}{' '}
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => void handleRetry()}
              >
                {t('ai.summarizeLongNotes.retry')}
              </Button>
            </span>
          )}
          {checked && (
            <Select
              value={agent}
              onValueChange={(value) => void handleAgentChange(value as FoldAgentChoice)}
            >
              <SelectTrigger
                className={`me-3 ${COMPACT_SELECT}`}
                aria-label={t('ai.summarizeLongNotes.agentLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agentOptions.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id === 'auto' ? t('ai.summarizeLongNotes.agentAuto') : AGENT_LABELS[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Switch
            checked={checked}
            onCheckedChange={(...args) => void handleChange(...args)}
            className={ACCENT_SWITCH}
            aria-label={t('ai.summarizeLongNotes.label')}
          />
        </div>
      </SettingRow>
      {checked && agentStatus && agentStatus.resolved === null && (
        <p className="pb-2.5 text-xs/4 text-muted-foreground">
          {t('ai.summarizeLongNotes.noAgent')}{' '}
          <Button variant="link" size="sm" className="h-auto p-0 text-xs/4" onClick={onOpenAgents}>
            {t('ai.summarizeLongNotes.openAgents')}
          </Button>
        </p>
      )}
    </Fragment>
  )
}
