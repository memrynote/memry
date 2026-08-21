/**
 * Wiring for the note mind map: what the note page needs and nothing more.
 *
 * The data source is the live editor block tree, read from the editor that is
 * still mounted behind the map. No main-process read, no index query, no
 * markdown re-parse — and no diffing machinery either, because the user cannot
 * type and look at the map at the same time.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDirection } from '@memry/i18n/renderer'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { useTabViewState } from '@/hooks/use-tab-view-state'
import { buildMindMap } from './build-mind-map'
import type { MindMap, MindMapSourceBlock } from './mind-map-types'

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
  /** Null until the map is open and has been built. */
  map: MindMap | null
  /** Pass to the content area in place of the callback that was composed in. */
  handleEditorReady: (editor: unknown) => void
  /**
   * Rebuild from the live block tree. Called when the note reports a different
   * set of headings, which is how the map catches up with a note whose content
   * finished loading after a restored tab reopened the map.
   */
  refresh: () => void
}

export function useMindMap({ noteTitle, onEditorReady }: UseMindMapOptions): UseMindMapResult {
  const { isEnabled } = useFeatureFlags()
  const isAvailable = isEnabled('spatialCanvas')
  const direction = useDirection()

  const [storedOpen, setStoredOpen] = useTabViewState<boolean>({
    key: MIND_MAP_VIEW_STATE_KEY,
    defaultValue: false,
    parse: parseMindMapOpen
  })
  const isOpen = isAvailable && storedOpen

  const editorRef = useRef<BlockTreeHost | null>(null)
  const [editorRevision, setEditorRevision] = useState(0)
  const [map, setMap] = useState<MindMap | null>(null)

  const handleEditorReady = useCallback(
    (editor: unknown) => {
      editorRef.current = (editor as BlockTreeHost | null) ?? null
      setEditorRevision((previous) => previous + 1)
      onEditorReady(editor)
    },
    [onEditorReady]
  )

  const build = useCallback(
    () => buildMindMap(readBlocks(editorRef.current), { rootLabel: noteTitle, direction }),
    [direction, noteTitle]
  )

  // Layout, not passive: the note body is hidden in the same commit that flips
  // the toggle, so a map that arrived a frame later would paint a blank gap.
  useLayoutEffect(() => {
    if (!isOpen) {
      setMap(null)
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

  return useMemo(
    () => ({ isAvailable, isOpen, toggle, map, handleEditorReady, refresh }),
    [isAvailable, isOpen, toggle, map, handleEditorReady, refresh]
  )
}
