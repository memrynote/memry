import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { SettingsHeader, SettingsGroup } from '@/components/settings/settings-primitives'
import { Button } from '@/components/ui/button'
import { Download } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { taskKeys } from '@/features/tasks/use-task-queries'
import { useTodoistImport } from '@/components/import/use-todoist-import'
import type { TickTickImportSummary } from '@memry/contracts/ticktick-import-api'

const log = createLogger('Settings:Import')

export function ImportSettings() {
  const { t } = useT('settings')
  const queryClient = useQueryClient()
  const { preview, isPreviewing, isImporting, chooseFiles, confirmImport, cancel } =
    useTodoistImport()
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<TickTickImportSummary | null>(null)

  const runTickTickImport = async () => {
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
      <SettingsHeader title={t('import.header.title')} subtitle={t('import.header.subtitle')} />
      <SettingsGroup label={t('import.todoist.title')}>
        <p className="text-muted-foreground mb-3">{t('import.todoist.description')}</p>
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void chooseFiles()}
            disabled={isPreviewing || isImporting}
          >
            <Download className="w-3.5 h-3.5 me-1.5" />
            {t('import.todoist.choose')}
          </Button>
        </div>

        {preview && (
          <div className="mt-4 flex flex-col gap-3">
            {preview.files.map((f) => (
              <div key={f.fileName} className="rounded-md border border-border p-3">
                <div className="font-medium">{f.projectName || f.fileName}</div>
                {f.error ? (
                  <div className="text-destructive mt-1">{f.error}</div>
                ) : (
                  <>
                    <div className="text-muted-foreground mt-1">
                      {t('import.todoist.counts', {
                        tasks: f.stats.tasks,
                        subtasks: f.stats.subtasks,
                        withDueDate: f.stats.withDueDate,
                        comments: f.stats.comments,
                        skipped: f.stats.skipped
                      })}
                    </div>
                    {f.sampleTitles.length > 0 && (
                      <div className="text-muted-foreground mt-1 truncate">
                        {f.sampleTitles.join(' · ')}
                      </div>
                    )}
                    {f.warnings.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer">
                          {t('import.todoist.warnings')} ({f.warnings.length})
                        </summary>
                        <ul className="mt-1 ps-4 list-disc">
                          {f.warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void confirmImport()} disabled={isImporting}>
                {t('import.todoist.import')}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel} disabled={isImporting}>
                {t('import.todoist.cancel')}
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup label={t('import.ticktick.title')}>
        <p className="text-muted-foreground mb-3">{t('import.ticktick.description')}</p>
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runTickTickImport()}
            disabled={busy}
          >
            <Download className="w-3.5 h-3.5 me-1.5" />
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
      </SettingsGroup>
    </div>
  )
}
