import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { SettingsHeader } from '@/components/settings/settings-primitives'
import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { taskKeys } from '@/features/tasks/use-task-queries'
import type { TickTickImportSummary } from '@memry/contracts/ticktick-import-api'

const log = createLogger('Settings:Import')

export function ImportSettings() {
  const { t } = useT('settings')
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<TickTickImportSummary | null>(null)

  const runImport = async () => {
    setBusy(true)
    setSummary(null)
    try {
      const result = await window.api.tickTickImport.run()
      if (result.canceled) return
      setSummary(result)
      await queryClient.invalidateQueries({ queryKey: taskKeys.all })
      toast.success(t('import.ticktick.success', { count: result.stats.tasks }))
    } catch (err) {
      log.error('TickTick import failed', err)
      toast.error(extractErrorMessage(err, t('import.ticktick.failed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
        title={t('import.ticktick.title')}
        subtitle={t('import.ticktick.description')}
      />
      <div className="mt-4">
        <Button onClick={() => void runImport()} disabled={busy}>
          {busy ? t('import.ticktick.importing') : t('import.ticktick.button')}
        </Button>
      </div>
      {summary && (
        <div className="mt-4 text-xs text-muted-foreground">
          <p>
            {t('import.ticktick.result', {
              projects: summary.stats.projects,
              tasks: summary.stats.tasks,
              subtasks: summary.stats.subtasks,
              reminders: summary.stats.reminders
            })}
          </p>
          {summary.warnings.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer">
                {t('import.ticktick.warnings', { count: summary.warnings.length })}
              </summary>
              <ul className="mt-1 list-disc ps-4">
                {summary.warnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
