import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { SettingRow, ACCENT_SWITCH } from '@/components/settings/settings-primitives'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:Settings:AI')

interface SummarizeLongNotesRowProps {
  checked: boolean
  onSaved: (value: boolean) => void
}

export function SummarizeLongNotesRow({ checked, onSaved }: SummarizeLongNotesRowProps) {
  const { t } = useT('settings')
  const [failed, setFailed] = useState(false)

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

  return (
    <SettingRow
      label={t('ai.summarizeLongNotes.label')}
      description={t('ai.summarizeLongNotes.description')}
    >
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
      <Switch
        checked={checked}
        onCheckedChange={(...args) => void handleChange(...args)}
        className={ACCENT_SWITCH}
        aria-label={t('ai.summarizeLongNotes.label')}
      />
    </SettingRow>
  )
}
