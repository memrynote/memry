import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { Loader2 } from '@/lib/icons'
import { useSyncOptional } from '@/contexts/sync-context'
import { useT } from '@memry/i18n/renderer'

/**
 * "This note's contents may still be on their way" strip for the progressive
 * vault open (#1830).
 *
 * Vault open no longer waits for the first full sync, so a note can be listed
 * — and opened — before its cold CRDT batch has applied. Main seeds nothing
 * into the doc for an empty markdown file, so the editor binds a live, EMPTY
 * fragment; without a hint that renders as a phantom empty body the user may
 * read as data loss. Saving one is already impossible — the live fragment
 * suppresses the whole-markdown save, and the unmerged-remote flag keeps
 * snapshot pushes off the pruning endpoint — so this is presentation only, and
 * it deliberately does NOT block typing: edits merge additively via CRDT.
 *
 * Visible only while BOTH hold:
 *  - the initial full sync is still running (the only window in which "empty"
 *    plausibly means "not yet arrived" rather than "empty note"), and
 *  - the bound fragment is empty (the body streams in live the moment the
 *    batch applies, which is what clears the hint).
 *
 * A genuinely empty note opened mid-initial-sync shows the hint until the sync
 * completes — an honest "may still be syncing", not an error.
 *
 * Sync context is optional: canvas embeds and unit tests mount editors without
 * a provider, and no provider must read as "no initial sync running".
 */
export function BodySyncPendingHint({ fragment }: { fragment: Y.XmlFragment }) {
  const { t } = useT('notes')
  const initialSyncActive = useSyncOptional()?.state.initialSyncProgress != null
  const [isEmpty, setIsEmpty] = useState(() => fragment.length === 0)

  useEffect(() => {
    // Only observed while the hint could show — the observer is torn down for
    // the whole steady-state life of the editor.
    if (!initialSyncActive) return

    const update = (): void => setIsEmpty(fragment.length === 0)
    update()
    // Deep, not shallow: the batch apply can materialize nested structure in
    // one transaction, and a missed top-level-only event would strand the hint.
    fragment.observeDeep(update)
    return () => fragment.unobserveDeep(update)
  }, [fragment, initialSyncActive])

  if (!initialSyncActive || !isEmpty) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground bg-muted/40 border-b border-border/60"
    >
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      <span className="truncate">{t('editor.bodySyncPending')}</span>
    </div>
  )
}
