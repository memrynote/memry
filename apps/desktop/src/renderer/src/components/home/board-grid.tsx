import { useMemo, useRef } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout/legacy'
import 'react-grid-layout/css/styles.css'
import './home-grid.css'
import { WidgetFrame } from './widget-frame'
import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import {
  applyLayout,
  removeWidget,
  updateWidgetConfig,
  type GridLayoutItem
} from '@/lib/home/layout-reducer'
import {
  GRID_COLS,
  GRID_ROW_HEIGHT,
  GRID_MARGIN,
  MIN_W,
  MIN_H,
  sizeTier
} from '@/lib/home/widget-sizes'
import type { HomePage } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'

const Grid = WidthProvider(GridLayout)

interface BoardGridProps {
  board: HomePage
  onChange: (next: HomePage) => void
}

// react-grid-layout calls onLayoutChange on mount (and after vertical compaction), not only on real
// edits. Skip persisting when nothing actually moved/resized, so we don't loop refetch → re-render.
function unchanged(board: HomePage, next: Layout): boolean {
  if (board.widgets.length !== next.length) return false
  const byId = new Map(next.map((l) => [l.i, l]))
  return board.widgets.every((w) => {
    const l = byId.get(w.id)
    return !!l && l.x === w.x && l.y === w.y && l.w === w.w && l.h === w.h
  })
}

export function BoardGrid({ board, onChange }: BoardGridProps): React.JSX.Element {
  const { t } = useT('common')
  const reduceMotion = useReducedMotion()

  const layout: Layout = useMemo(
    () =>
      board.widgets.map((w) => {
        const min = WIDGET_REGISTRY[w.type]?.minLayout
        return {
          i: w.id,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          minW: min?.w ?? MIN_W,
          minH: min?.h ?? MIN_H
        }
      }),
    [board.widgets]
  )

  // Boards sync, so a peer's apply can invalidate ['home-boards'] mid-drag: the `board` prop
  // changes and the controlled `layout` prop is swapped under react-grid-layout while the pointer
  // is still down, which snaps the widget back and discards the drag. Hold the pre-interaction
  // layout until the pointer lifts; the next render picks up whatever arrived in the meantime.
  const interacting = useRef(false)
  const frozenLayout = useRef<Layout | null>(null)
  const effectiveLayout = interacting.current ? (frozenLayout.current ?? layout) : layout

  const beginInteraction = (): void => {
    interacting.current = true
    frozenLayout.current = layout
  }
  const endInteraction = (): void => {
    interacting.current = false
    frozenLayout.current = null
  }

  // The grid has one column count at every width, so what RGL reports here IS the board's
  // arrangement — persist it. (It used to be responsive: below the `lg` width RGL reported a
  // collapsed layout that could not be persisted without destroying the stored arrangement, so
  // every drag and resize made on a narrower window was silently discarded — issue #1216.)
  const handleLayoutChange = (next: Layout): void => {
    if (unchanged(board, next)) return
    onChange(applyLayout(board, next as GridLayoutItem[]))
  }

  return (
    <Grid
      className="home-grid"
      layout={effectiveLayout}
      cols={GRID_COLS}
      rowHeight={GRID_ROW_HEIGHT}
      margin={GRID_MARGIN}
      compactType="vertical"
      draggableHandle=".widget-drag-handle"
      draggableCancel=".widget-no-drag"
      resizeHandles={['se']}
      isBounded
      onDragStart={beginInteraction}
      onDragStop={endInteraction}
      onResizeStart={beginInteraction}
      onResizeStop={endInteraction}
      onLayoutChange={handleLayoutChange}
    >
      {board.widgets.map((w, index) => {
        const def = WIDGET_REGISTRY[w.type]
        const size = sizeTier(w.w, w.h)
        // react-grid-layout clones this plain wrapper div (injecting position styles, drag handlers,
        // and appending the resize handle). Keeping it a vanilla element — rather than letting RGL
        // clone WidgetFrame directly — is what makes drag/resize wiring reliable. The materialize
        // animation therefore lives on an inner motion.div: RGL owns the wrapper's transform for
        // positioning, so the two never fight over the same element.
        return (
          <div key={w.id} className="overflow-visible">
            <motion.div
              className="h-full w-full"
              initial={
                reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, filter: 'blur(6px)' }
              }
              animate={
                reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, filter: 'blur(0px)' }
              }
              transition={{
                type: 'spring',
                bounce: 0,
                duration: 0.45,
                delay: Math.min(index * 0.04, 0.32)
              }}
            >
              {def ? (
                <WidgetFrame
                  widget={w}
                  size={size}
                  title={t(def.titleKey)}
                  icon={def.icon}
                  onRemove={() => onChange(removeWidget(board, w.id))}
                  ConfigEditor={def.ConfigEditor}
                  HeaderFilter={def.HeaderFilter}
                  HeaderCount={def.HeaderCount}
                  Footer={def.Footer}
                  onConfigChange={(cfg) => onChange(updateWidgetConfig(board, w.id, cfg))}
                  content={<def.Component config={w.config} size={size} />}
                />
              ) : (
                <WidgetFrame
                  widget={w}
                  size={size}
                  title={t('home.widget.unknown')}
                  onRemove={() => onChange(removeWidget(board, w.id))}
                  content={
                    <p data-testid="widget-unknown" className="text-sm text-muted-foreground">
                      {t('home.widget.unknown')}
                    </p>
                  }
                />
              )}
            </motion.div>
          </div>
        )
      })}
    </Grid>
  )
}
