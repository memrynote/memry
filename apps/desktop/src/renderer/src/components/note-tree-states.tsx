import { FileQuestion, Plus, Loader2, AlertCircle } from '@/lib/icons'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'

export function NotesTreeSkeleton() {
  return (
    <div className="space-y-2 p-2">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-3/4 ml-4" />
      <Skeleton className="h-6 w-3/4 ml-4" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-2/3 ml-4" />
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
