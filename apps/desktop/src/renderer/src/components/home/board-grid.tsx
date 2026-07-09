import { useMemo } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  Responsive,
  WidthProvider,
  type Layout,
  type ResponsiveLayouts
} from 'react-grid-layout/legacy'
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
  GRID_BREAKPOINTS,
  GRID_COLS,
  GRID_ROW_HEIGHT,
  GRID_MARGIN,
  MIN_W,
  MIN_H,
  sizeTier
} from '@/lib/home/widget-sizes'
import type { HomePage } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'

const ResponsiveGrid = WidthProvider(Responsive)

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

  // Responsive RGL switches to a fewer-column breakpoint below `lg` width and reports the COLLAPSED
  // layout as the first arg. Persisting that would overwrite the stored desktop arrangement and it
  // never returns on resize-up. The model's x/y/w/h are authored against `lg`, so persist only the
  // `lg` entry from allLayouts — it stays intact across breakpoint collapses, the first arg doesn't.
  const handleLayoutChange = (_current: Layout, allLayouts: ResponsiveLayouts): void => {
    const lg = allLayouts.lg
    if (!lg || unchanged(board, lg)) return
    onChange(applyLayout(board, lg as GridLayoutItem[]))
  }

  return (
    <ResponsiveGrid
      className="home-grid"
      layouts={{ lg: layout }}
      breakpoints={GRID_BREAKPOINTS}
      cols={GRID_COLS}
      rowHeight={GRID_ROW_HEIGHT}
      margin={GRID_MARGIN}
      compactType="vertical"
      draggableHandle=".widget-drag-handle"
      draggableCancel=".widget-no-drag"
      resizeHandles={['se']}
      isBounded
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
    </ResponsiveGrid>
  )
}
