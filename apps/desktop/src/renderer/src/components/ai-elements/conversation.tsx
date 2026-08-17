import {
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject
} from 'react'

import { cn } from '@/lib/utils'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { useTabEntityViewState } from '@/hooks/use-tab-entity-view-state'
import {
  AGENT_CONVERSATION_SCROLL_KEY,
  conversationScrollAction,
  parseConversationScroll,
  scrollStateFor,
  type ConversationScrollState
} from './stick-to-bottom'

/** How often the live position is committed to tab state while scrolling. */
const SAVE_THROTTLE_MS = 500
/** Sub-pixel tolerance when deciding whether a restore reached its target. */
const OFFSET_EPSILON = 1

/**
 * Keeps the transcript pinned to the newest message while the reader is at the
 * bottom, leaves them alone the moment they scroll up, and puts them back where
 * they were on the way into the tab.
 *
 * The old behaviour was `useEffect(() => scrollTo(bottom), [children])` with no
 * guard at all: every streamed token, and any re-render that produced a new
 * children array, dragged the reader back down mid-sentence.
 */
function useStickToBottom(scrollRef: RefObject<HTMLDivElement | null>, children: ReactNode): void {
  const entityId = useTabIdentity()?.entityId
  const [stored, setStored] = useTabEntityViewState<ConversationScrollState | null>({
    key: AGENT_CONVERSATION_SCROLL_KEY,
    defaultValue: null,
    parse: parseConversationScroll
  })

  /**
   * The LIVE policy. Seeded from tab state and then owned by the scroll
   * listener, because the commit to tab state is throttled: reading `stored`
   * here would keep saying "bottom" for half a second after the user scrolled
   * up, and every token arriving in that window would haul them back down.
   */
  const storedRef = useRef<ConversationScrollState | null>(stored)
  const seededEntityRef = useRef<string | undefined>(entityId)
  /** Whether the stored offset has been applied, or the user has overridden it. */
  const restoredRef = useRef(false)
  /** The offset our own programmatic write produced, so its echo is ignored. */
  const lastWrittenRef = useRef<number | null>(null)
  const pendingRef = useRef<ConversationScrollState | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setStoredRef = useRef(setStored)

  useLayoutEffect(() => {
    setStoredRef.current = setStored
  })

  // A tab reused for another conversation starts over: its stored position
  // belongs to the transcript that has just been replaced.
  useEffect(() => {
    if (seededEntityRef.current === entityId) return
    seededEntityRef.current = entityId
    storedRef.current = stored
    restoredRef.current = false
    lastWrittenRef.current = null
  }, [entityId, stored])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined

    const flush = (): void => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending === null) return
      setStoredRef.current(pending)
    }

    const handleScroll = (): void => {
      // The echo of our own stick/restore write, delivered asynchronously.
      if (element.scrollTop === lastWrittenRef.current) return
      lastWrittenRef.current = null
      restoredRef.current = true
      storedRef.current = scrollStateFor(element)
      pendingRef.current = storedRef.current
      if (saveTimerRef.current === null) {
        saveTimerRef.current = setTimeout(flush, SAVE_THROTTLE_MS)
      }
    }

    element.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      element.removeEventListener('scroll', handleScroll)
      flush()
    }
  }, [scrollRef])

  // Runs on mount and on every children change — which, while a turn is
  // running, is once per streamed token.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const action = conversationScrollAction({
      stored: storedRef.current,
      restored: restoredRef.current
    })

    if (action.kind === 'none') return

    if (action.kind === 'stick') {
      // Assignment rather than `scrollTo`: the browser clamps it to the
      // reachable range exactly the same way, and it is the one form jsdom
      // implements, so the tests around this component keep running.
      element.scrollTop = element.scrollHeight
      lastWrittenRef.current = element.scrollTop
      return
    }

    // The transcript arrives asynchronously, so the scroller may still be too
    // short to reach the target; the browser clamps the write, and the next
    // batch of children gives it another go.
    element.scrollTop = action.offset
    lastWrittenRef.current = element.scrollTop
    if (Math.abs(element.scrollTop - action.offset) <= OFFSET_EPSILON) {
      restoredRef.current = true
    }
  }, [children, scrollRef])
}

export type ConversationProps = ComponentProps<'div'>

export function Conversation({
  children,
  className,
  ...props
}: ConversationProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useStickToBottom(scrollRef, children)

  return (
    <div
      ref={scrollRef}
      role="log"
      className={cn('relative min-h-0 flex-1 overflow-y-auto', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export type ConversationContentProps = ComponentProps<'div'>

export function ConversationContent({
  className,
  ...props
}: ConversationContentProps): React.JSX.Element {
  return <div className={cn('flex flex-col gap-3 px-2 py-3', className)} {...props} />
}
