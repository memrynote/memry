import { FileQuestion, Plus, Loader2, AlertCircle } from '@/lib/icons'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'

export function NotesTreeSkeleton() {
  return (
    <div className="space-y-2 p-2">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-3/4 ms-4" />
      <Skeleton className="h-6 w-3/4 ms-4" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-2/3 ms-4" />
    </div>
  )
}

export function NotesTreeEmpty({
  onCreateNote,
  isCreating
}: {
  onCreateNote: () => void
  isCreating: boolean
}) {
  const { t } = useT('notes')

  return (
    <div className="flex flex-col items-center justify-center p-4 text-center text-muted-foreground">
      <FileQuestion className="h-8 w-8 mb-2 opacity-50" />
      <p className="text-sm">{t('tree.empty.title')}</p>
      <p className="text-xs opacity-70 mb-3">{t('tree.empty.body')}</p>
      <Button
        variant="outline"
        size="sm"
        onClick={onCreateNote}
        disabled={isCreating}
        className="gap-1.5"
      >
        {isCreating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        {t('tree.empty.newNote')}
      </Button>
    </div>
  )
}

/**
 * Footer for a truncated tree.
 *
 * The sidebar fetches notes a page at a time, newest-modified first. Without
 * this row the notes past the ceiling are simply absent — and since the tree is
 * the primary navigation surface, absent reads as deleted.
 */
export function NotesTreeTruncationNotice({
  hiddenCount,
  isLoadingMore,
  onLoadMore
}: {
  hiddenCount: number
  isLoadingMore: boolean
  onLoadMore: () => void
}) {
  const { t } = useT('notes')

  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-muted-foreground">
      <span>{t('tree.truncated.hidden', { count: hiddenCount })}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onLoadMore}
        disabled={isLoadingMore}
        className="h-6 gap-1 px-2 text-xs"
      >
        {isLoadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
        {t('tree.truncated.loadMore')}
      </Button>
    </div>
  )
}

export function NotesTreeError({ error }: { error: string }) {
  const { t } = useT('notes')

  return (
    <div className="flex flex-col items-center justify-center p-4 text-center text-destructive">
      <AlertCircle className="h-8 w-8 mb-2" />
      <p className="text-sm">{t('tree.loadingError')}</p>
      <p className="text-xs opacity-70">{error}</p>
    </div>
  )
}
