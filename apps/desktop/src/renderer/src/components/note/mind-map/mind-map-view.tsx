/**
 * The map surface: its toolbar, the size notice, the drawing, its accessible
 * twin, and the empty-note hint.
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
 * camera is NOT persisted. The map is a derived view rebuilt from the note each
 * time it opens, so a restored camera could point at coordinates the new drawing
 * no longer uses — the same reason the map's expansion state is not persisted
 * either. And the loss costs nothing: reopening the map puts the camera on the
 * section the reader was in, and "Fit to view" is one click away.
 *
 * Where a fresh camera POINTS is decided here too. Framing the whole map is the
 * right answer only for a reader who has nowhere in particular to be; anyone who
 * scrolled to a section and then asked for the picture asked for the picture OF
 * THAT SECTION, so the block they were reading is resolved to a box and handed
 * down as the opening target. It is resolved here rather than below because this
 * is the layer holding the map, and only the map knows whether a given block was
 * drawn at all.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Focus, Image, PenTool, Save } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { buildMemryHref } from '@/lib/memry-links'
import { resolveWikiLink } from '@/lib/wikilink-resolver'
import { canvasService } from '@/services/canvas-service'
import { mindMapDestinations } from './mind-map-destination'
import { mindMapHrefForBlock } from './mind-map-focus'
import { mindMapHrefOf } from './mind-map-hover'
import { nodeFromMindMapLink, type MindMapNodeActivation } from './mind-map-navigation'
import { mintSnapshotElements, uniqueCanvasTitle } from './mind-map-snapshot'
import { MindMapToolbar, type MindMapToolbarAction } from './mind-map-toolbar'
import { MindMapTree } from './mind-map-tree'
import type { MindMapControls, MindMapHoverLabel } from './mind-map-canvas'
import type { MindMap, MindMapPositionedNode } from './mind-map-types'

const log = createLogger('NoteMindMap')

/**
 * Lazy for the same reason the canvas page is: @excalidraw/excalidraw and its
 * CSS never enter the main renderer bundle.
 */
const LazyMindMapCanvas = lazy(async () => ({
  default: (await import('./mind-map-canvas')).MindMapCanvas
}))

/**
 * Wiki-link nodes, resolved to hrefs that still mean something on another
 * device.
 *
 * On screen a wiki-link box's href is only a click handle — the real
 * destination is `wikiTarget`, a TITLE, and `activateMindMapNode` turns it into
 * a tab. A saved canvas has neither: nothing on the other side reads
 * `wikiTarget`, so the target has to be resolved to a real id here, once, at
 * the moment the file is written.
 *
 * Through `resolveWikiLink`, the same resolver a `[[…]]` in the note body goes
 * through, so a saved link opens exactly what clicking the link opens — a note
 * at its heading, or a filed binary in its viewer. Resolved once per distinct
 * target rather than once per node, because a note that links to `Roadmap` five
 * times should cost one lookup.
 *
 * A target that resolves to nothing gets no entry, and its box falls back to
 * the heading anchor every other node carries: it opens the source note at the
 * section the link is written in. Better than a dead box, and it invents no
 * destination — a `create` resolution means the note does not exist yet, and
 * freezing "make this note" into a document is not a promise a file can keep.
 */
async function resolveWikiHrefs(
  nodes: readonly MindMapPositionedNode[],
  labels: ReadonlyMap<string, string>
): Promise<Map<string, string>> {
  const links = nodes.filter((node) => node.kind === 'wikiLink' && node.wikiTarget !== null)
  const targets = [...new Set(links.map((node) => node.wikiTarget as string))]

  // A wiki node's name comes from its target alone, so every node sharing a
  // target shares a name and the label can be resolved once per target too.
  const labelByTarget = new Map<string, string>()
  for (const node of links) {
    const target = node.wikiTarget as string
    if (!labelByTarget.has(target)) labelByTarget.set(target, labels.get(node.id) ?? '')
  }

  const byTarget = new Map<string, string>()
  await Promise.all(
    targets.map(async (target) => {
      const resolved = await resolveWikiLink(target).catch(() => null)
      if (!resolved || (resolved.type !== 'note' && resolved.type !== 'file')) return

      const href = buildMemryHref({
        kind: resolved.type,
        id: resolved.id,
        // So the canvas' link bubble says the page this box opens rather than
        // its address. A hint, never an identity — the id is what resolves, and
        // the opening path reads the item's real title before it names a tab.
        label: labelByTarget.get(target) || null,
        // A filed binary has no inside to address; a note takes the heading half
        // of `[[Note#Heading]]` exactly as the editor would.
        anchor:
          resolved.type === 'note' && resolved.heading
            ? { type: 'heading', text: resolved.heading }
            : null
      })
      if (href) byTarget.set(target, href)
    })
  )

  const hrefs = new Map<string, string>()
  for (const node of links) {
    const href = byTarget.get(node.wikiTarget as string)
    if (href) hrefs.set(node.id, href)
  }
  return hrefs
}

interface MindMapViewProps {
  map: MindMap
  /** The note the map is of, so a drawn box's deep link resolves to a node. */
  noteId: string
  /** The note title. User content; never translated. */
  noteTitle: string
  /** One handler for both projections — the picture and the tree agree. */
  onActivateNode: MindMapNodeActivation
  /**
   * The block the reader was on when they opened the map, so it opens on that
   * section instead of on the whole picture. Null when there is nothing to aim
   * at — an untitled top-of-note, or a note with no headings.
   */
  initialFocusBlockId?: string | null
  /**
   * Handed a way to move the open map's camera to a block, and `null` the moment
   * there is no live surface to move.
   *
   * A block id rather than an href, because that is what the outline panel has,
   * and resolving one to the other is this layer's job. `false` back means the
   * block was not drawn — folded behind a "+N more", or dropped at the node cap
   * — which is what lets the caller fall back to opening the note at it rather
   * than swallowing the click.
   */
  onFocusChange?: (focusBlock: ((blockId: string) => boolean) | null) => void
}

export function MindMapView({
  map,
  noteId,
  noteTitle,
  onActivateNode,
  initialFocusBlockId = null,
  onFocusChange
}: MindMapViewProps): React.JSX.Element {
  const { t } = useT('notes')
  const [controls, setControls] = useState<MindMapControls | null>(null)
  const [isSaving, setSaving] = useState(false)

  /**
   * What each node's link opens, said as a name.
   *
   * Composed here because this is the layer with a translator: the separator
   * between segments is chrome and has to follow the reading direction, while
   * the names it joins — headings, list items, note titles — are the user's own
   * words and are never translated.
   *
   * One derivation feeds both surfaces. The drawn map renders it on hover; the
   * saved canvas freezes it into each href as a `?label=`, which is the only
   * hook the drawing library's own bubble has.
   */
  const destinations = useMemo(
    () => mindMapDestinations(map.nodes, { separator: t('mindMap.chain.separator') }),
    [map.nodes, t]
  )

  /**
   * The same names, keyed the way a click and a hover arrive: by the href the
   * box carries.
   *
   * Read off the minted elements rather than re-derived, so the affordance can
   * only ever describe a box that was actually drawn.
   */
  const hoverLabels = useMemo(() => {
    const byId = new Map(map.nodes.map((node) => [node.id, node]))
    const linkHint = t('mindMap.linkHint')
    const labels = new Map<string, MindMapHoverLabel>()

    for (const element of map.elements) {
      if (element.type !== 'rectangle') continue
      const href = mindMapHrefOf(element)
      const node = byId.get(element.id)
      if (href === null || !node) continue
      labels.set(href, {
        chain: destinations.get(node.id) ?? '',
        hint: node.kind === 'wikiLink' ? linkHint : null
      })
    }
    return labels
  }, [destinations, map.elements, map.nodes, t])

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

  /**
   * Mints a canvas from the map as currently drawn, and lets go of it.
   *
   * A NEW canvas every time, at the canvas root, named after the note with the
   * vault's own collision suffix. Nothing is overwritten and nothing is written
   * back to the note: from here on the canvas is the user's alone.
   *
   * The date is formatted here because this is the layer with a locale, and it
   * is frozen into the file — a snapshot says when it was taken, not what time
   * it is now.
   */
  const save = useCallback((): void => {
    setSaving(true)
    void (async () => {
      const [{ toCanvasScene }, existing, wikiHrefs] = await Promise.all([
        import('./mind-map-export'),
        canvasService.list(),
        resolveWikiHrefs(map.nodes, destinations)
      ])

      const generatedLabel = t('mindMap.toolbar.snapshotOn', {
        date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date())
      })
      const scene = toCanvasScene(
        mintSnapshotElements(map, { noteId, generatedLabel, wikiHrefs, labels: destinations })
      )
      // Only the canvas ROOT can collide: that is where this one is filed. The
      // note's own folder tree is deliberately not mirrored — gluing the two
      // trees together would make every note rename a canvas move.
      const title = uniqueCanvasTitle(
        noteTitle.trim() || t('editor.title.untitled'),
        existing.canvases.filter((canvas) => canvas.folder === null).map((canvas) => canvas.title)
      )

      await canvasService.create({ title, scene, folder: null })
      toast.success(t('mindMap.toolbar.saved', { title }))
    })()
      .catch((err: unknown) => {
        log.warn('Failed to save the mind map as a canvas', err)
        toast.error(extractErrorMessage(err, t('mindMap.toolbar.saveFailed')))
      })
      .finally(() => setSaving(false))
  }, [destinations, map, noteId, noteTitle, t])

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
      },
      {
        // A fourth entry in the same array, not a new slot: the toolbar takes
        // its actions as data precisely so this needed no new prop.
        //
        // Unlike the three above it does not wait on the drawing surface — the
        // saved document is minted from the map's own descriptors, not read off
        // the live scene — so it is only inert while a save is in flight.
        id: 'save-canvas',
        label: t('mindMap.toolbar.saveCanvas'),
        icon: Save,
        disabled: isSaving,
        onSelect: save
      }
    ],
    [controls, copy, isSaving, save, t]
  )

  // Empty until the map is actually at its limit — see the region below.
  const capNotice = map.reachedNodeCap ? t('mindMap.nodeCapNotice', { count: map.nodeCount }) : ''

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

  const initialFocusHref = useMemo(
    () => (initialFocusBlockId === null ? null : mindMapHrefForBlock(map, initialFocusBlockId)),
    [initialFocusBlockId, map]
  )

  const focusBlock = useMemo(() => {
    if (controls === null) return null
    return (blockId: string): boolean => {
      const href = mindMapHrefForBlock(map, blockId)
      return href === null ? false : controls.focus(href)
    }
  }, [controls, map])

  // The same handshake `onControlsChange` makes one layer down, one layer up:
  // the surface announces itself when it is live and takes the announcement
  // back when it is not, so nothing is ever wired to a camera that is gone.
  //
  // The rule's advice — lift the state to the parent — is the wrong shape here.
  // What the parent is being handed is a way to CALL the drawing surface, and
  // the surface is mounted below this component precisely so that Excalidraw
  // stays out of the main bundle. Lifting it would move the lazy boundary.
  useEffect(() => {
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-pass-live-state-to-parent
    onFocusChange?.(focusBlock)
    return () => onFocusChange?.(null)
  }, [focusBlock, onFocusChange])

  return (
    <div className="relative flex h-full w-full flex-col bg-background" data-testid="note-mind-map">
      <MindMapToolbar actions={actions} label={t('mindMap.toolbar.label')} />

      {/* Above the picture and outside it, for the same reason the toolbar is:
          anything inside an image role is presentational, and this is the one
          line that tells a reader the map is not the whole note.

          Mounted whether or not it has anything to say, and empty when it does
          not. A live region that appears with its text already in it is one a
          screen reader can miss entirely — and the moment this line matters
          most is the one where opening a branch is what spent the last of the
          budget, which happens while the reader is already here. */}
      <p
        role="status"
        className={capNotice === '' ? 'sr-only' : 'px-3 pb-2 text-xs text-text-tertiary'}
        data-testid="note-mind-map-cap-notice"
      >
        {capNotice}
      </p>

      <div
        role="img"
        aria-label={t('mindMap.regionLabel', { title: noteTitle, count: map.nodeCount })}
        className="relative min-h-0 flex-1"
      >
        <Suspense fallback={<div className="h-full w-full" aria-hidden="true" />}>
          <LazyMindMapCanvas
            elements={map.elements}
            hoverLabels={hoverLabels}
            onOpenLink={handleOpenLink}
            initialFocusHref={initialFocusHref}
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
