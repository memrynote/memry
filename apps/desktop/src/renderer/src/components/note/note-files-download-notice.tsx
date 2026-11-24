import { useEffect, useState } from 'react'
import { AlertCircle, Loader2 } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'
import type { NoteFilesRetry } from '@memry/contracts/ipc-attachments'

/**
 * A note that misses no file answers at once. Showing the notice only past this
 * keeps it from flashing on every note that opens.
 */
const SHOW_DOWNLOADING_AFTER_MS = 300

/** `failure` is main's error message, or what the IPC call threw. */
type DownloadState = 'idle' | 'downloading' | { failure: unknown; retry: NoteFilesRetry }

/**
 * A sync pass can bring a file the open note lacks: sync starting, or a pull
 * that names a new file. A failure Try again or the server settles waits.
 */
const asksOnSync = (state: DownloadState): boolean =>
  state === 'idle' || (typeof state === 'object' && state.retry === 'whenSyncRuns')

/**
 * With attachment auto-download off, a note's files stay on the server until
 * the note is opened (#5616). Mounting this asks main for them and shows the
 * outcome, and each sync status change asks again while a sync pass can bring
 * one; each block re-renders on its own once its file lands. Mount it with
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
    let asking = false
    let settled: DownloadState = 'idle'
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = async (): Promise<void> => {
      asking = true
      timer = setTimeout(() => {
        if (current) setState('downloading')
      }, SHOW_DOWNLOADING_AFTER_MS)
      try {
        const result = await window.api.syncAttachments.downloadNoteFiles({ noteId })
        settled = result.success ? 'idle' : { failure: result.error, retry: result.retry ?? 'now' }
      } catch (err) {
        settled = { failure: err, retry: 'now' }
      }
      clearTimeout(timer)
      asking = false
      if (current) setState(settled)
    }
    void ask()
    const unsubscribe = window.api.onSyncStatusChanged(() => {
      if (!asking && asksOnSync(settled)) void ask()
    })
    return () => {
      current = false
      clearTimeout(timer)
      unsubscribe()
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
      {state.retry === 'now' && (
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
