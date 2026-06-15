import { Button } from '@/components/ui/button'
import { SettingsHeader, SettingsGroup } from '@/components/settings/settings-primitives'
import { useT } from '@memry/i18n/renderer'
import { Download } from '@/lib/icons'
import { useTodoistImport } from '@/components/import/use-todoist-import'

export function ImportSettings() {
  const { t } = useT('settings')
  const { preview, isPreviewing, isImporting, chooseFiles, confirmImport, cancel } =
    useTodoistImport()

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('import.header.title')} subtitle={t('import.header.subtitle')} />
      <SettingsGroup label={t('import.todoist.title')}>
        <p className="text-muted-foreground mb-3">{t('import.todoist.description')}</p>
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={chooseFiles}
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
              <Button size="sm" onClick={confirmImport} disabled={isImporting}>
                {t('import.todoist.import')}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel} disabled={isImporting}>
                {t('import.todoist.cancel')}
              </Button>
            </div>
          </div>
        )}
      </SettingsGroup>
    </div>
  )
}
