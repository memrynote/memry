import { useEffect, useState, type RefObject } from 'react'

export const RAIL_OFFSET_PX = 56
export const RAIL_WIDTH_PX = 284

const FULL_MIN_RIGHT_SPACE_PX = RAIL_OFFSET_PX + RAIL_WIDTH_PX
const COMPACT_MIN_CONTAINER_WIDTH_PX = 200

export type CommentsRailMode = 'full' | 'compact' | 'hidden'

function resolveMode(rect: DOMRect, viewportWidth: number): CommentsRailMode {
  const spaceRight = viewportWidth - rect.right
  if (spaceRight >= FULL_MIN_RIGHT_SPACE_PX) return 'full'
  if (rect.width >= COMPACT_MIN_CONTAINER_WIDTH_PX) return 'compact'
  return 'hidden'
}

export function useCommentsRailMode(containerRef: RefObject<HTMLElement | null>): CommentsRailMode {
  const [mode, setMode] = useState<CommentsRailMode>('compact')

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const element = containerRef.current
    if (!element) return undefined

    const update = (): void => {
      const rect = element.getBoundingClientRect()
      setMode(resolveMode(rect, window.innerWidth))
    }

    update()

    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [containerRef])

  return mode
}
