/**
 * Wiring for the note mind map: what the note page needs and nothing more.
 *
 * The data source is the live editor block tree, read from the editor that is
 * still mounted behind the map. No main-process read, no index query, no
 * markdown re-parse — and no diffing machinery either, because the user cannot
 * type and look at the map at the same time.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDirection, useT } from '@memry/i18n/renderer'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useTabViewState } from '@/hooks/use-tab-view-state'
import { buildMindMap } from './build-mind-map'
import type { MindMap, MindMapContentKind, MindMapSourceBlock } from './mind-map-types'

/**
 * Tab view state key. Tab-scoped on purpose: the map is a property of a
 * workspace, not of a note, so the same note opened in another tab starts in
 * note view. It survives a tab switch and a session restore for free.
 */
export const MIND_MAP_VIEW_STATE_KEY = 'noteMindMap'

/** Total, as persisted tab state can have been written by an older build. */
function parseMindMapOpen(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined
}

/**
 * No branch opened. A shared, frozen value so closing an already-collapsed map
 * is a no-op to React rather than a fresh set on every commit.
 *
 * Note what is NOT here: a view-state key. Expansion is deliberately kept in
 * memory only. The ids in it are derived from block ids, which the note re-mints
 * whenever it is edited, rebuilt or opened on another device, so persisting them
 * would fill tab state with identifiers that are stale by the time they are read
 * — and would have to be parsed and kept version-tolerant forever for a state
 * the user restores with one click.
 */
const NO_EXPANSION: ReadonlySet<string> = new Set<string>()

/** The slice of a BlockNote editor the map reads. */
interface BlockTreeHost {
  document?: unknown
}

function readBlocks(host: BlockTreeHost | null): MindMapSourceBlock[] {
  const document = host?.document
  if (!Array.isArray(document)) return []
  return document.filter(
    (block): block is MindMapSourceBlock =>
      typeof block === 'object' &&
      block !== null &&
      typeof (block as { id?: unknown }).id === 'string' &&
      typeof (block as { type?: unknown }).type === 'string'
  )
}

interface UseMindMapOptions {
  /** The note the map is of, so its boxes carry deep links back into it. */
  noteId: string
  /** Root label. User content; never translated. */
  noteTitle: string
  /**
   * The note page's existing editor-ready callback. Composed rather than
   * replaced so the map needs no new prop on the content area.
   */
  onEditorReady: (editor: unknown) => void
}

export interface UseMindMapResult {
  /** False when the spatial-canvas feature is off; the toggle is not offered. */
  isAvailable: boolean
  /** True while the map replaces the note body. */
  isOpen: boolean
  toggle: () => void
  /** Gives the note back. A no-op when the map is already closed, so the
   * outline panel can call it on every heading click without writing tab
   * state each time. */
  close: () => void
  /** Null until the map is open and has been built. */
  map: MindMap | null
  /**
   * Open the branch a "+N more" node stands for. In-memory only: it is dropped
   * when the map closes, and never written to tab view state.
   */
  expandBranch: (nodeId: string) => void
  /** Pass to the content area in place of the callback that was composed in. */
  handleEditorReady: (editor: unknown) => void
  /**
   * Rebuild from the live block tree. Called when the note reports a different
   * set of headings, which is how the map catches up with a note whose content
   * finished loading after a restored tab reopened the map.
   */
  refresh: () => void
}

export function useMindMap({
  noteId,
  noteTitle,
  onEditorReady
}: UseMindMapOptions): UseMindMapResult {
  const { isEnabled } = useFeatureFlags()
  const isAvailable = isEnabled('spatialCanvas')
  const direction = useDirection()
  const { t } = useT('notes')

  /**
   * Counter badges are app chrome, so they are translated and pluralised here
   * and handed to the pure pipeline, which has no translator of its own.
   *
   * Read through a ref, and the callback below never changes identity. That is
   * not tidiness: this feeds the rebuild effect, so a formatter that churned
   * per render would set state on every commit and the note page would never
   * settle. The cost is that a language switch does not re-word the badges of
   * an already-open map until it is toggled — the map is built on open anyway.
   */
  const translate = useRef(t)
  useEffect(() => {
    translate.current = t
  }, [t])

  const formatContentCount = useCallback(
    (kind: MindMapContentKind, count: number) =>
      translate.current(`mindMap.badge.${kind}`, { count }),
    []
  )

  /** Same contract, same reason: a fold marker is chrome, so it is translated. */
  const formatMore = useCallback(
    (count: number) => translate.current('mindMap.more', { count }),
    []
  )

  const [storedOpen, setStoredOpen] = useTabViewState<boolean>({
    key: MIND_MAP_VIEW_STATE_KEY,
    defaultValue: false,
    parse: parseMindMapOpen
  })
  const isOpen = isAvailable && storedOpen

  const editorRef = useRef<BlockTreeHost | null>(null)
  const [editorRevision, setEditorRevision] = useState(0)
  const [map, setMap] = useState<MindMap | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(NO_EXPANSION)

  const expandBranch = useCallback((nodeId: string) => {
    setExpanded((previous) => {
      if (previous.has(nodeId)) return previous
      const next = new Set(previous)
      next.add(nodeId)
      return next
    })
  }, [])

  const handleEditorReady = useCallback(
    (editor: unknown) => {
      editorRef.current = (editor as BlockTreeHost | null) ?? null
      setEditorRevision((previous) => previous + 1)
      onEditorReady(editor)
    },
    [onEditorReady]
  )

  const build = useCallback(
    () =>
      buildMindMap(readBlocks(editorRef.current), {
        rootLabel: noteTitle,
        direction,
        noteId,
        formatContentCount,
        formatMore,
        expanded
      }),
    [direction, noteId, noteTitle, formatContentCount, formatMore, expanded]
  )

  // Layout, not passive: the note body is hidden in the same commit that flips
  // the toggle, so a map that arrived a frame later would paint a blank gap.
  //
  // Closing drops the expansion with the map. Nothing to clean up on the way
  // out, and nothing to reconcile on the way in: the next open is the note's
  // shape as the note is now, which is the only shape those ids still fit.
  useLayoutEffect(() => {
    if (!isOpen) {
      setMap(null)
      setExpanded(NO_EXPANSION)
      return
    }
    setMap(build())
    // `editorRevision` is a rebuild trigger, not a value this reads.
  }, [isOpen, build, editorRevision])

  const refresh = useCallback(() => {
    setMap((previous) => (previous === null ? previous : build()))
  }, [build])

  const toggle = useCallback(() => {
    setStoredOpen((previous) => !previous)
  }, [setStoredOpen])

  const close = useCallback(() => {
    // Guarded: the setter always dispatches, and the outline panel calls this on
    // every heading click, map or no map.
    if (!storedOpen) return
    setStoredOpen(false)
  }, [storedOpen, setStoredOpen])

  return useMemo(
    () => ({ isAvailable, isOpen, toggle, close, map, expandBranch, handleEditorReady, refresh }),
    [isAvailable, isOpen, toggle, close, map, expandBranch, handleEditorReady, refresh]
  )
}
