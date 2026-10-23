/**
 * The live window: a real note editor bound to the SOURCE note, showing only
 * the blocks the portal's definition lets through.
 *
 * It is a nested `ContentArea` for the source's noteId, so it joins the one
 * Y.Doc the doc registry keeps per note in this window (the note's own tab and
 * every other window on it share it, with no private provider and no echo).
 * Edits made here land in the source; the host note stores only the reference.
 *
 * It mounts when it first scrolls near the viewport, because a note can hold
 * many portals and each opens a document.
 *
 * @module note/content-area/portal/portal-window
 */

import { Suspense, lazy, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react'
import { useT } from '@memry/i18n/renderer'
import { EditorErrorBoundary } from '@/components/note/editor-error-boundary'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { PortalAncestryContext } from './portal-context'
import type { PortalPlan } from './portal-plans'
import { descendPortalAncestry, type PortalAncestry, type PortalWindowTarget } from './portal-state'
import { usePortalLinkOpen } from './use-portal-link-open'
import { usePortalWindowPlugin, type PortalWindowResolution } from './use-portal-window-plugin'
import './portal-window.css'

const log = createLogger('PortalWindow')

// Loaded lazily because ContentArea imports `editor-schema`, which registers
// the portal block, which imports this file: a static import would close that
// loop at module load, before `editorSchema` exists.
const ContentArea = lazy(() =>
  import('../ContentArea').then((module) => ({ default: module.ContentArea }))
)

/** How long a mounted editor may go without a window plugin before it is given up on. */
const ATTACH_TIMEOUT_MS = 4000

/** Start the editor this far before it scrolls into view. */
const NEAR_VIEWPORT_MARGIN = '300px'

/** True once `ref` has come near the viewport; stays true. */
function useMountedNearViewport(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = ref.current
    if (near || !node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { rootMargin: NEAR_VIEWPORT_MARGIN }
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [near, ref])
  return near
}

/**
 * This window's editor handles its own keys, pastes and drops. React would
 * also deliver them to every enclosing editor's handlers, which would then act
 * on the same gesture a second time, in the host note.
 */
const keepInsideWindow = (event: SyntheticEvent): void => {
  event.stopPropagation()
}

export interface PortalWindowProps {
  /** The portal block in the host editor, for the window registry. */
  portalBlockId: string
  /** This draw of the portal block (`PortalInstanceContext`). */
  instanceId: string
  target: PortalWindowTarget
  /** The portals this one sits inside, host included. */
  ancestry: PortalAncestry
  sourcePath: string
  sourceContent: string
  /** False for a locked source. */
  editable: boolean
  onResolve: (resolution: PortalWindowResolution) => void
  /** Enter or Backspace in the window changed what the portal lists. */
  onPlan: (plan: PortalPlan) => void | Promise<unknown>
}

export function PortalWindow({
  portalBlockId,
  instanceId,
  target,
  ancestry,
  sourcePath,
  sourceContent,
  editable,
  onResolve,
  onPlan
}: PortalWindowProps): React.JSX.Element {
  const { t } = useT('common')
  const frameRef = useRef<HTMLDivElement>(null)
  const near = useMountedNearViewport(frameRef)
  const openLink = usePortalLinkOpen()
  const [attached, setAttached] = useState(false)
  const [failed, setFailed] = useState(false)
  const childAncestry = useMemo(() => descendPortalAncestry(ancestry, target), [ancestry, target])

  usePortalWindowPlugin({
    container: frameRef,
    enabled: near,
    portalBlockId,
    instanceId,
    sourceNoteId: target.note,
    spec: target,
    onResolve,
    onPlan,
    onAttached: setAttached
  })

  // Without its plugin the editor would show the whole source, so it stays out
  // of sight until the plugin is on, and is dropped if it never gets one.
  useEffect(() => {
    if (!near || attached) return
    const timer = setTimeout(() => {
      log.error('Portal window never attached', { portalBlockId, note: target.note })
      setFailed(true)
    }, ATTACH_TIMEOUT_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [near, attached, portalBlockId, target.note])

  if (failed && !attached) {
    return (
      <p className="py-1 text-xs text-destructive" role="alert">
        {t('portalBlock.windowFailed')}
      </p>
    )
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- delegating wrapper: handlers observe events bubbling from interactive children; the element is not itself a control
    <div
      ref={frameRef}
      className={cn('portal-window min-h-6', near && !attached && 'invisible')}
      data-portal-window=""
      data-marquee-ignore=""
      onKeyDown={keepInsideWindow}
      onPaste={keepInsideWindow}
      onCut={keepInsideWindow}
      onCopy={keepInsideWindow}
      onDrop={keepInsideWindow}
      onDragOver={keepInsideWindow}
      onDragEnter={keepInsideWindow}
      onDragLeave={keepInsideWindow}
    >
      {near ? (
        <PortalAncestryContext.Provider value={childAncestry}>
          <EditorErrorBoundary noteId={target.note}>
            <Suspense fallback={null}>
              <ContentArea
                noteId={target.note}
                notePath={sourcePath}
                editable={editable}
                initialContent={sourceContent}
                contentType="markdown"
                runSideEffects={false}
                onInternalLinkClick={openLink}
              />
            </Suspense>
          </EditorErrorBoundary>
        </PortalAncestryContext.Provider>
      ) : null}
    </div>
  )
}
