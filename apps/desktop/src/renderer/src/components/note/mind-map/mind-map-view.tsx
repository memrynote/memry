/**
 * The map surface: the drawing, its accessible twin, and the empty-note hint.
 *
 * Two projections of one layout result sit side by side here — the picture for
 * people who can see it, the tree for everyone and everything else. They are
 * siblings rather than nested because an image role makes its contents
 * presentational, which would hide the tree from exactly the readers it exists
 * for.
 */

import { lazy, Suspense, useCallback } from 'react'
import { useT } from '@memry/i18n/renderer'
import { nodeFromMindMapLink, type MindMapNodeActivation } from './mind-map-navigation'
import { MindMapTree } from './mind-map-tree'
import type { MindMap } from './mind-map-types'

/**
 * Lazy for the same reason the canvas page is: @excalidraw/excalidraw and its
 * CSS never enter the main renderer bundle.
 */
const LazyMindMapCanvas = lazy(async () => ({
  default: (await import('./mind-map-canvas')).MindMapCanvas
}))

interface MindMapViewProps {
  map: MindMap
  /** The note the map is of, so a drawn box's deep link resolves to a node. */
  noteId: string
  /** The note title. User content; never translated. */
  noteTitle: string
  /** One handler for both projections — the picture and the tree agree. */
  onActivateNode: MindMapNodeActivation
}

export function MindMapView({
  map,
  noteId,
  noteTitle,
  onActivateNode
}: MindMapViewProps): React.JSX.Element {
  const { t } = useT('notes')

  // A click on the drawing arrives as the deep link of the box it landed on;
  // that is the only handle a bitmap surface gives us. Resolving it back to a
  // node here means both projections end in the same activation, rather than
  // the picture growing a navigation path of its own.
  const handleOpenLink = useCallback(
    (href: string) => {
      const node = nodeFromMindMapLink(href, map.nodes, noteId)
      if (node) onActivateNode(node)
    },
    [map.nodes, noteId, onActivateNode]
  )

  return (
    <div className="relative flex h-full w-full flex-col bg-background" data-testid="note-mind-map">
      <div
        role="img"
        aria-label={t('mindMap.regionLabel', { title: noteTitle, count: map.nodeCount })}
        className="relative min-h-0 flex-1"
      >
        <Suspense fallback={<div className="h-full w-full" aria-hidden="true" />}>
          <LazyMindMapCanvas elements={map.elements} onOpenLink={handleOpenLink} />
        </Suspense>
      </div>

      {map.isEmpty && (
        <p
          className="pointer-events-none absolute inset-x-0 bottom-10 text-center text-sm text-text-tertiary"
          data-testid="note-mind-map-empty-hint"
        >
          {t('mindMap.emptyHint')}
        </p>
      )}

      <MindMapTree
        nodes={map.nodes}
        label={t('mindMap.treeLabel', { title: noteTitle })}
        onActivateNode={onActivateNode}
      />
    </div>
  )
}
