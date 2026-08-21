/**
 * The map surface: its toolbar, the drawing, its accessible twin, and the
 * empty-note hint.
 *
 * Two projections of one layout result sit side by side here — the picture for
 * people who can see it, the tree for everyone and everything else. They are
 * siblings rather than nested because an image role makes its contents
 * presentational, which would hide the tree from exactly the readers it exists
 * for. The toolbar is a sibling for the same reason.
 *
 * The map's controls live here and nowhere else. The note header's overflow
 * menu is untouched in both modes: one control in one place doing two different
 * things depending on the mode is how a note gets deleted by accident.
 *
 * Mount lifetime, decided here because this is where viewport state arrives:
 * the drawing surface is mounted on toggle and unmounted on close, and the
 * camera is NOT persisted. Every open frames the whole map. The map is a
 * derived view rebuilt from the note each time it opens, so a restored camera
 * could point at coordinates the new drawing no longer uses — the same reason
 * the map's expansion state is not persisted either. And the loss costs
 * nothing: reopening the map puts the camera exactly where "Fit to view" puts
 * it, so the state is one click from recovery rather than something to store,
 * parse and keep compatible across versions.
 */

import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Focus, Image, PenTool } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { nodeFromMindMapLink, type MindMapNodeActivation } from './mind-map-navigation'
import { MindMapToolbar, type MindMapToolbarAction } from './mind-map-toolbar'
import { MindMapTree } from './mind-map-tree'
import type { MindMapControls } from './mind-map-canvas'
import type { MindMap } from './mind-map-types'

const log = createLogger('NoteMindMap')

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
  const [controls, setControls] = useState<MindMapControls | null>(null)

  const copy = useCallback(
    (run: () => Promise<void>, success: string): void => {
      void run()
        .then(() => toast.success(success))
        .catch((err: unknown) => {
          // Nothing disappears quietly: a copy that failed says so.
          log.warn('Failed to copy the mind map', err)
          toast.error(extractErrorMessage(err, t('mindMap.toolbar.copyFailed')))
        })
    },
    [t]
  )

  const actions = useMemo<MindMapToolbarAction[]>(
    () => [
      {
        id: 'fit',
        label: t('mindMap.toolbar.fit'),
        icon: Focus,
        disabled: controls === null,
        onSelect: () => controls?.fit()
      },
      {
        id: 'copy-image',
        label: t('mindMap.toolbar.copyImage'),
        icon: Image,
        disabled: controls === null,
        onSelect: () => {
          if (controls) copy(controls.copyImage, t('mindMap.toolbar.imageCopied'))
        }
      },
      {
        id: 'copy-vector',
        label: t('mindMap.toolbar.copyVector'),
        icon: PenTool,
        disabled: controls === null,
        onSelect: () => {
          if (controls) copy(controls.copyVector, t('mindMap.toolbar.vectorCopied'))
        }
      }
    ],
    [controls, copy, t]
  )

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
      <MindMapToolbar actions={actions} label={t('mindMap.toolbar.label')} />

      <div
        role="img"
        aria-label={t('mindMap.regionLabel', { title: noteTitle, count: map.nodeCount })}
        className="relative min-h-0 flex-1"
      >
        <Suspense fallback={<div className="h-full w-full" aria-hidden="true" />}>
          <LazyMindMapCanvas
            elements={map.elements}
            onOpenLink={handleOpenLink}
            onControlsChange={setControls}
          />
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
        linkHint={t('mindMap.linkHint')}
        onActivateNode={onActivateNode}
      />
    </div>
  )
}
