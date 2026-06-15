import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useImportRun } from '@/hooks/use-import-run'
import type { ImportCatalogItem } from '@/lib/import-catalog'

interface ImportDialogProps {
  item: ImportCatalogItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImportDialog({ item, open, onOpenChange }: ImportDialogProps) {
  const { t } = useT('settings')
  const run = useImportRun()
  const [paths, setPaths] = useState<string[]>([])

  const reset = () => {
    setPaths([])
    run.reset()
  }

  const handleOpenChange = (next: boolean) => {
    if (run.isRunning) return // don't dismiss an in-flight import
    if (!next) reset()
    onOpenChange(next)
  }

  const choose = async () => {
    if (!item) return
    const result = await window.api.import.pickFiles({
      label: item.fileLabel,
      extensions: item.extensions,
      allowMultiple: item.allowMultiple
    })
    if (!result.canceled && result.filePaths.length > 0) setPaths(result.filePaths)
  }

  const startImport = () => {
    if (!item || paths.length === 0 || run.isRunning) return
    void run.start(item.id, paths)
  }

  const summary = run.summary
  const showProgress = (run.isRunning || Boolean(run.progress)) && !run.error

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? t('import.dialog.title', { name: item.name }) : ''}</DialogTitle>
          <DialogDescription>{item ? t(item.descriptionKey) : ''}</DialogDescription>
        </DialogHeader>

        {!summary && (
          <div className="flex flex-col gap-3 py-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void choose()}
              disabled={run.isRunning}
            >
              {t('import.dialog.choose')}
            </Button>
            {paths.length > 0 && (
              <p className="text-xs/4 text-muted-foreground truncate">
                {t('import.dialog.selected', { count: paths.length })}
              </p>
            )}

            {showProgress && (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-active p-3">
                <div className="flex items-center gap-2 text-[13px]/4 text-foreground">
                  {run.isRunning && <Spinner />}
                  <span className="truncate">
                    {run.progress?.status || t('import.dialog.running')}
                  </span>
                </div>
                {run.progress && run.progress.total > 0 && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                    <div
                      className="h-full rounded-full bg-[var(--tint)] transition-[width]"
                      style={{
                        width: `${Math.min(100, Math.round((run.progress.completed / run.progress.total) * 100))}%`
                      }}
                    />
                  </div>
                )}
                <p className="text-xs/4 text-muted-foreground">
                  {t('import.dialog.progress', {
                    completed: run.progress?.completed ?? 0,
                    total: run.progress?.total ?? 0
                  })}
                </p>
              </div>
            )}

            {run.error && <p className="text-xs/4 text-destructive">{run.error}</p>}
          </div>
        )}

        {summary && (
          <div className="flex flex-col gap-1.5 py-2">
            <p className="font-medium text-[13px]/4 text-foreground">
              {t('import.dialog.summary.title')}
            </p>
            <p className="text-xs/4 text-muted-foreground">
              {t('import.dialog.summary.imported', { count: summary.imported })}
            </p>
            <p className="text-xs/4 text-muted-foreground">
              {t('import.dialog.summary.attachments', { count: summary.attachments })}
            </p>
            {summary.skipped > 0 && (
              <p className="text-xs/4 text-muted-foreground">
                {t('import.dialog.summary.skipped', { count: summary.skipped })}
              </p>
            )}
            {summary.failed.length > 0 && (
              <p className="text-xs/4 text-destructive">
                {t('import.dialog.summary.failed', { count: summary.failed.length })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {summary ? (
            <Button size="sm" onClick={() => handleOpenChange(false)}>
              {t('import.dialog.done')}
            </Button>
          ) : run.isRunning ? (
            <Button variant="outline" size="sm" onClick={() => run.cancel()}>
              {t('import.dialog.cancel')}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={paths.length === 0}
              onPointerDown={startImport}
              onClick={startImport}
            >
              {t('import.dialog.start')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
