/**
 * J1: the dialogs that change or drop what notes carry. Each counts what it
 * touches first (`tags:preview-impact`), and keeps every typed value.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { isReservedFieldName } from '@memry/contracts/tag-schema'
import type { ImpactQuery, ImpactResult } from '@memry/contracts/tag-schema-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { extractErrorMessage } from '@/lib/ipc-error'
import { tagsService } from '@/services/tags-service'
import { useEditTagSchema } from '../use-tag-schemas'

function useImpact<K extends ImpactResult['kind']>(
  query: ImpactQuery & { kind: K },
  enabled: boolean
): Extract<ImpactResult, { kind: K }> | undefined {
  const result = useQuery({
    queryKey: ['tags', 'preview-impact', query],
    enabled,
    staleTime: 0,
    queryFn: () => tagsService.previewImpact(query)
  })
  const data = result.data
  return data && data.kind === query.kind ? (data as Extract<ImpactResult, { kind: K }>) : undefined
}

interface ShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: React.ReactNode
  footer: React.ReactNode
}

function ImpactDialogShell({
  open,
  onOpenChange,
  title,
  children,
  footer
}: ShellProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px] gap-4">
        <DialogTitle className="text-base">{title}</DialogTitle>
        {children}
        <DialogFooter className="gap-2">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface RemoveFieldDialogProps {
  tag: string
  field: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RemoveFieldDialog({
  tag,
  field,
  open,
  onOpenChange
}: RemoveFieldDialogProps): React.JSX.Element {
  const { t } = useT('notes')
  const editSchema = useEditTagSchema()
  const impact = useImpact({ kind: 'remove-field', tag, name: field }, open)
  const [busy, setBusy] = useState(false)

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      await editSchema({ kind: 'remove-field', tag, name: field })
      onOpenChange(false)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.removeField')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ImpactDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('tagFields.settings.remove.title', { field, tag })}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('tagFields.settings.cancel')}
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
            {t('tagFields.settings.remove.confirm')}
          </Button>
        </>
      }
    >
      <DialogDescription asChild>
        <div className="text-sm text-text-secondary">
          {impact ? (
            t('tagFields.settings.remove.body', {
              field,
              filled: impact.filled,
              empty: impact.empty
            })
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
        </div>
      </DialogDescription>
    </ImpactDialogShell>
  )
}

interface RenameFieldDialogProps {
  field: string
  /** Lowercase field names already on the tag, other than this one. */
  taken: ReadonlySet<string>
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RenameFieldDialog({
  field,
  taken,
  open,
  onOpenChange
}: RenameFieldDialogProps): React.JSX.Element {
  const { t } = useT('notes')
  const editSchema = useEditTagSchema()
  const impact = useImpact({ kind: 'rename-field', name: field }, open)
  const [name, setName] = useState(field)
  const [progress, setProgress] = useState<{ runId: string; done: number; total: number } | null>(
    null
  )
  const runId = progress?.runId ?? null

  useEffect(() => {
    if (!runId) return
    return window.api.onTagsProgress((event) => {
      if (event.runId !== runId) return
      setProgress({ runId, done: event.done, total: event.total })
    })
  }, [runId])

  const trimmed = name.trim()
  const error = !trimmed
    ? null
    : isReservedFieldName(trimmed)
      ? t('tagFields.settings.addField.reserved', { name: trimmed })
      : taken.has(trimmed.toLowerCase())
        ? t('tagFields.settings.rename.taken', { name: trimmed })
        : null
  const running = progress !== null
  const canRename = !running && trimmed !== '' && trimmed !== field && error === null

  const handleOpenChange = (next: boolean): void => {
    if (running) return
    if (next) setName(field)
    onOpenChange(next)
  }

  const rename = async (): Promise<void> => {
    const id = crypto.randomUUID()
    setProgress({ runId: id, done: 0, total: impact?.notes ?? 0 })
    try {
      const result = await editSchema({ kind: 'rename-field', from: field, to: trimmed, runId: id })
      toast.success(
        t('tagFields.settings.rename.done', {
          from: field,
          to: trimmed,
          count: (result.rename?.notes ?? 0) + (result.rename?.tasks ?? 0)
        })
      )
      setProgress(null)
      onOpenChange(false)
    } catch (err) {
      setProgress(null)
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.renameField')))
    }
  }

  return (
    <ImpactDialogShell
      open={open}
      onOpenChange={handleOpenChange}
      title={
        trimmed && trimmed !== field
          ? t('tagFields.settings.rename.title', { from: field, to: trimmed })
          : t('tagFields.settings.rename.titleEmpty', { from: field })
      }
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={running}
            onClick={() => onOpenChange(false)}
          >
            {t('tagFields.settings.cancel')}
          </Button>
          <Button size="sm" disabled={!canRename} onClick={() => void rename()}>
            {t('tagFields.settings.rename.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Input
          autoFocus
          value={name}
          disabled={running}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canRename) void rename()
          }}
          aria-label={t('tagFields.settings.rename.label')}
          className="h-9"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <DialogDescription asChild>
        <div className="text-sm text-text-secondary">
          {impact ? (
            t('tagFields.settings.rename.body', { field, count: impact.notes })
          ) : (
            <Skeleton className="h-10 w-full" />
          )}
        </div>
      </DialogDescription>
      {progress && (
        <div className="flex flex-col gap-2 rounded-md bg-muted/60 px-3 py-2.5">
          <div className="flex items-center justify-between text-xs text-text-secondary">
            <span>{t('tagFields.settings.rename.progress')}</span>
            <span className="tabular-nums">
              {progress.done} / {progress.total}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-foreground motion-safe:transition-[width]"
              style={{
                width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`
              }}
            />
          </div>
        </div>
      )}
    </ImpactDialogShell>
  )
}

interface DeleteTagDialogProps {
  tag: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteTagDialog({
  tag,
  open,
  onOpenChange
}: DeleteTagDialogProps): React.JSX.Element {
  const { t } = useT('notes')
  const impact = useImpact({ kind: 'delete-tag', tag }, open)
  const [busy, setBusy] = useState(false)

  const remove = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await tagsService.deleteTag(tag)
      if (!result.success) throw new Error(result.error ?? t('tagFields.settings.errors.deleteTag'))
      toast.success(t('tagFields.settings.delete.done', { tag }))
      // The tag page closes itself on the tag-deleted event.
      onOpenChange(false)
    } catch (err) {
      toast.error(extractErrorMessage(err, t('tagFields.settings.errors.deleteTag')))
    } finally {
      setBusy(false)
    }
  }

  const body = !impact
    ? null
    : impact.fields === 0
      ? t('tagFields.settings.delete.bodyPlain', { tag })
      : impact.templateName
        ? t('tagFields.settings.delete.body', { tag, notes: impact.notes, fields: impact.fields })
        : t('tagFields.settings.delete.bodyNoTemplate', {
            tag,
            notes: impact.notes,
            fields: impact.fields
          })

  return (
    <ImpactDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t('tagFields.settings.delete.title', { tag })}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('tagFields.settings.cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || !impact}
            onClick={() => void remove()}
          >
            {t('tagFields.settings.delete.confirm')}
          </Button>
        </>
      }
    >
      <DialogDescription asChild>
        <div className="text-sm text-text-secondary">
          {body ?? <Skeleton className="h-10 w-full" />}
        </div>
      </DialogDescription>
      {impact && impact.fields > 0 && (
        <div className="flex flex-col gap-1 rounded-md bg-muted/60 px-4 py-3">
          <Stat value={impact.notes} label={t('tagFields.settings.delete.statNotes')} />
          <Stat value={impact.values} label={t('tagFields.settings.delete.statValues')} />
        </div>
      )}
      <p className="text-sm text-text-secondary">
        {t('tagFields.settings.delete.plainText', { tag })}
      </p>
    </ImpactDialogShell>
  )
}

function Stat({ value, label }: { value: number; label: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-text-secondary">{label}</span>
    </div>
  )
}
