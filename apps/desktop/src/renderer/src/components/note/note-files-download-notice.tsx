import { useEffect, useState } from 'react'
import { AlertCircle, Loader2 } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'

/**
 * A note that misses no file answers at once. Showing the notice only past this
 * keeps it from flashing on every note that opens.
 */
const SHOW_DOWNLOADING_AFTER_MS = 300

/**
 * `failure` is main's error message, or what the IPC call threw. `canRetry` is
 * false when asking again cannot help, such as a file the server no longer has.
 */
type DownloadState = 'idle' | 'downloading' | { failure: unknown; canRetry: boolean }

/**
 * With attachment auto-download off, a note's files stay on the server until
 * the note is opened (#5616). Mounting this asks main for them and shows the
 * outcome; each block re-renders on its own once its file lands. Mount it with
 * `key={noteId}` so another note starts from a clean state.
 */
export function NoteFilesDownloadNotice({ noteId }: { noteId: string }): React.JSX.Element {
  const [attempt, setAttempt] = useState(0)
  // Each attempt mounts afresh, so Try again asks main again.
  return (
    <NoteFilesDownload
      key={attempt}
      noteId={noteId}
      retry={attempt > 0}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  )
}

function NoteFilesDownload({
  noteId,
  retry,
  onRetry
}: {
  noteId: string
  /** The user asked again: show progress at once. */
  retry: boolean
  onRetry: () => void
}): React.JSX.Element | null {
  const { t } = useT('notes')
  const [state, setState] = useState<DownloadState>(retry ? 'downloading' : 'idle')

  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      if (current) setState('downloading')
    }, SHOW_DOWNLOADING_AFTER_MS)
    void (async () => {
      let next: DownloadState
      try {
        const result = await window.api.syncAttachments.downloadNoteFiles({ noteId })
        next = result.success
          ? 'idle'
          : { failure: result.error, canRetry: result.canRetry !== false }
      } catch (err) {
        next = { failure: err, canRetry: true }
      }
      clearTimeout(timer)
      if (current) setState(next)
    })()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [noteId])

  if (state === 'idle') return null
  if (state === 'downloading') {
    return (
      <output
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="note-files-downloading"
      >
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        <span>{t('page.noteFiles.downloading')}</span>
      </output>
    )
  }
  const error = extractErrorMessage(state.failure, t('page.noteFiles.failedFallback'))
  return (
    <div
      role="alert"
      className="flex items-start gap-1.5 text-xs text-destructive"
      data-testid="note-files-download-failed"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{t('page.noteFiles.failed', { error })}</span>
      {state.canRetry && (
        <Button
          variant="ghost"
          size="sm"
          className="-my-1 h-6 shrink-0 px-2 text-xs"
          onClick={onRetry}
        >
          {t('page.noteFiles.retry')}
        </Button>
      )}
    </div>
  )
}
