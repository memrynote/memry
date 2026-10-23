import { useEffect, useRef, type RefObject } from 'react'
import { findBlockRefBlockId, type BlockRef } from '@/lib/block-ref'
import { scrollToHeadingWhenReady } from '@/lib/scroll-to-heading'
import { RESTORE_MAX_MS } from '@/hooks/use-tab-scroll-restore'

/**
 * Scrolls a note to the block that refers to another note's block (a portal or
 * a link), once the editor has drawn it, then calls `onSettled` so the tab does
 * not jump again the next time it is shown. Same wait the heading jump uses: the
 * editor renders behind a placeholder until its document binds.
 */
export function useBlockRefScroll(
  ref: BlockRef | undefined,
  containerRef: RefObject<HTMLElement | null>,
  onSettled: () => void
): void {
  const refKey = ref ? (ref.kind === 'portal' ? `portal:${ref.ordinal}` : `link:${ref.anchor}`) : ''
  const refValue = useRef(ref)
  refValue.current = ref
  const settled = useRef(onSettled)
  settled.current = onSettled

  useEffect(() => {
    if (!refKey) return undefined
    return scrollToHeadingWhenReady({
      getContainer: () => containerRef.current,
      getHeadingId: () =>
        refValue.current ? findBlockRefBlockId(containerRef.current, refValue.current) : null,
      smooth: false,
      timeoutMs: RESTORE_MAX_MS,
      onSettled: () => {
        settled.current()
      }
    })
  }, [refKey, containerRef])
}
