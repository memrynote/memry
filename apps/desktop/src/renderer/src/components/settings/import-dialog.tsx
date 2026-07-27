import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
import { notesKeys } from '@/hooks/use-notes-query'
import type { ImporterItem } from '@/hooks/use-importers'

interface ImportDialogProps {
  item: ImporterItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImportDialog({ item, open, onOpenChange }: ImportDialogProps) {
  const { t } = useT('settings')
  const run = useImportRun()
  const queryClient = useQueryClient()
  const [paths, setPaths] = useState<string[]>([])

  // The import runner drains its projection pipeline before resolving, so once a
  // summary arrives the note_cache is complete. Refetch the sidebar tree (notes +
  // folders + tags) so imported notes appear without a manual reload.
  useEffect(() => {
    if (!run.summary) return
    void queryClient.invalidateQueries({ queryKey: notesKeys.lists() })
    void queryClient.invalidateQueries({ queryKey: notesKeys.folders() })
    void queryClient.invalidateQueries({ queryKey: notesKeys.tags() })
  }, [run.summary, queryClient])

  const reset = () => {
    setPaths([])
    run.reset()
  }

  const handleOpenChange = (next: boolean) => {
    if (run.isRunning) return // don't dismiss an in-flight import
    if (!next) reset()
    onOpenChange(next)
  }

  const choose = async (directory = false) => {
    if (!item) return
    const result = await window.api.import.pickFiles({
      label: item.fileSpec.label,
      extensions: item.fileSpec.extensions,
      allowMultiple: item.fileSpec.allowMultiple,
      directory: directory || item.fileSpec.directory,
      defaultPath: item.fileSpec.defaultPath,
      message: item.fileSpec.message
    })
    if (result.canceled || result.filePaths.length === 0) return
    setPaths(result.filePaths)
    if (item.supportsPreview) void run.runPreview(item.id, result.filePaths)
  }

  const isDirectoryPick = Boolean(item?.fileSpec.directory)
  // Electron degrades a combined file+directory panel to directory-only on
  // Windows/Linux, so an importer that accepts either gets two buttons.
  const offersFolderToo = Boolean(item?.fileSpec.allowDirectory) && !isDirectoryPick

  const startImport = () => {
    if (!item || paths.length === 0 || run.isRunning) return
    void run.start(item.id, paths)
  }

  const summary = run.summary
  const showProgress = (run.isRunning || Boolean(run.progress)) && !run.error
  const needsPreview = Boolean(item?.supportsPreview)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{item ? t('import.dialog.title', { name: item.name }) : ''}</DialogTitle>
          <DialogDescription>{item ? t(item.descriptionKey) : ''}</DialogDescription>
        </DialogHeader>

        {!summary && (
          <div className="flex min-w-0 flex-col gap-3 py-2">
            {isDirectoryPick && (
              <p className="text-xs/4 text-muted-foreground">{t('import.dialog.folderHint')}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void choose()}
                disabled={run.isRunning || run.isPreviewing}
              >
                {isDirectoryPick ? t('import.dialog.chooseFolder') : t('import.dialog.choose')}
              </Button>
              {offersFolderToo && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void choose(true)}
                  disabled={run.isRunning || run.isPreviewing}
                >
                  {t('import.dialog.chooseDirectory')}
                </Button>
              )}
            </div>
            {offersFolderToo && (
              <p className="text-xs/4 text-muted-foreground">
                {t('import.dialog.folderKeepsAssets')}
              </p>
            )}
            {paths.length > 0 && (
              <p className="text-xs/4 text-muted-foreground truncate">
                {t('import.dialog.selected', { count: paths.length })}
              </p>
            )}

            {run.isPreviewing && (
              <div className="flex items-center gap-2 text-[13px]/4 text-foreground">
                <Spinner />
                <span>{t('import.dialog.running')}</span>
              </div>
            )}

            {run.preview && (
              <div className="flex flex-col gap-3">
                {run.preview.groups.map((g, gi) => (
                  <div key={gi} className="rounded-md border border-border p-3 text-xs/4">
                    <div className="font-medium text-[13px]/4 text-foreground">{g.label}</div>
                    {g.error ? (
                      <div className="mt-1 text-destructive">{g.error}</div>
                    ) : (
                      <>
                        <div className="mt-1 text-muted-foreground">
                          {g.counts.map((c) => t(c.labelKey, { count: c.value })).join(' · ')}
                        </div>
                        {g.sampleTitles && g.sampleTitles.length > 0 && (
                          <div className="mt-1 truncate text-muted-foreground">
                            {g.sampleTitles.join(' · ')}
                          </div>
                        )}
                        {g.warnings && g.warnings.length > 0 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer">
                              {t('import.preview.warnings')} ({g.warnings.length})
                            </summary>
                            <ul className="mt-1 ps-4 list-disc">
                              {g.warnings.map((w, i) => (
                                <li key={i}>{w}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
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
            {summary.attachments > 0 && (
              <p className="text-xs/4 text-muted-foreground">
                {t('import.dialog.summary.attachments', { count: summary.attachments })}
              </p>
            )}
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
              disabled={paths.length === 0 || run.isPreviewing || (needsPreview && !run.preview)}
              onPointerDown={startImport}
              onClick={startImport}
            >
              {needsPreview ? t('import.preview.confirm') : t('import.dialog.start')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
