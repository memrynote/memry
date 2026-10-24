import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useAvailableCommands } from '@/commands'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'
import { cn } from '@/lib/utils'
import { findParagraph } from './fold-display'
import { paragraphPosition } from './fold-anchor'
import {
  firstVisibleParagraph,
  flashBlock,
  insertTypedText,
  placeCaretAtEnd,
  placeCaretInParagraph
} from './fold-caret'
import { foldedMarkdown } from './fold-copy'
import { FoldBody } from './fold-overlay'
import { FoldPill } from './fold-pill'
import { escapeHasEffect } from './fold-state'
import { createWheelStepper } from './fold-wheel'
import type { NoteFold } from './use-note-fold'

const INCOMING = 'animate-in fade-in duration-150 motion-reduce:animate-none'

/** Esc belongs to an open menu or dialog first. */
const OWNS_ESCAPE =
  '[role="menu"], [role="dialog"], [role="listbox"], [data-radix-popper-content-wrapper]'

/** Keys that mean "I want to write": they return to Full instead of doing nothing. */
function isTypingKey(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key === 'Backspace' || event.key === 'Delete') return true
  if (event.key.length !== 1) return false
  // Space activates a focused line button.
  return !(event.key === ' ' && event.target instanceof HTMLButtonElement)
}

interface FoldSurfaceProps {
  fold: NoteFold
  /** The editor's own wrapper. It stays mounted, with its Yjs binding, while folded. */
  children: ReactNode
}

/**
 * Hosts the editor and its folded overlay. The overlay is a read-only layer over
 * the editor, which stays mounted and is hidden, never unmounted, so the
 * document is never touched. Returning to Full puts the caret back where the
 * reader last clicked.
 */
export function FoldSurface({ fold, children }: FoldSurfaceProps) {
  const { t } = useT('notes')
  const tabId = useTabIdentity()?.tabId ?? null
  const activeTabId = useAvailableCommands().activeTabId
  // Esc is for the tab the reader is in; a background tab keeps its fold.
  const inActiveTab = tabId === null || tabId === activeTabId
  const rootRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLElement>(null)
  const {
    layers,
    folded,
    surfaces,
    state,
    view,
    level,
    dispatch,
    step,
    setLevel,
    retry,
    foldable
  } = fold

  // ⌘/Ctrl + scroll and trackpad pinch step levels inside the note area only.
  useEffect(() => {
    const root = rootRef.current
    if (!root || !foldable) return undefined
    const stepper = createWheelStepper()
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const direction = stepper.push(event.deltaY, performance.now())
      if (direction !== 0) step(direction)
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [foldable, step])

  // Esc closes opened paragraphs first, then returns to Full.
  useEffect(() => {
    if (!folded) return undefined
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(OWNS_ESCAPE)) return
      if (!inActiveTab) return
      if (!escapeHasEffect(state)) return
      event.preventDefault()
      dispatch({ type: 'escape' })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [folded, inActiveTab, state, dispatch])

  // ⌘C over a fold with nothing selected copies what the reader sees, as Markdown the
  // editor parses back into blocks. A real selection copies normally.
  useEffect(() => {
    if (!folded || !view) return undefined
    const onCopy = (event: ClipboardEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      const overFold = target === document.body || overlayRef.current?.contains(target)
      if (!overFold || !inActiveTab) return
      if (window.getSelection()?.toString()) return
      event.clipboardData?.setData('text/plain', foldedMarkdown(view))
      event.preventDefault()
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [folded, view, inActiveTab])

  // Folding takes focus off the editor so keys reach the overlay.
  useEffect(() => {
    if (!folded) return
    const active = document.activeElement
    if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur()
    if (document.activeElement === document.body) overlayRef.current?.focus({ preventScroll: true })
  }, [folded])

  // Back at Full: caret on the paragraph the reader last touched, flashed after a chip jump.
  // A key that started the return to Full never reached the hidden editor, so it is typed in once the caret is placed.
  // `typingParagraph` is where it lands when the reader touched no paragraph: the first one on screen.
  const pendingText = useRef<string | null>(null)
  const typingParagraph = useRef<string | null>(null)
  const wasFolded = useRef(folded)
  const anchor = state.anchor
  const flash = state.flash
  useEffect(() => {
    const returned = wasFolded.current && !folded
    wasFolded.current = folded
    if (!returned) return
    const typed = pendingText.current
    const target = anchor ?? typingParagraph.current
    pendingText.current = null
    typingParagraph.current = null
    const root = rootRef.current
    if (!root) return
    const paragraph = layers && target ? findParagraph(layers, target) : null
    const position = layers && target ? paragraphPosition(layers, target) : undefined
    let block = paragraph ? placeCaretInParagraph(root, paragraph.text, position) : null
    // Nothing matched: the key still lands, at the end of the note, rather than being lost.
    if (typed) {
      block ??= placeCaretAtEnd(root)
      if (block) insertTypedText(root, block, typed)
    }
    if (block && flash !== null && flash === anchor) {
      flashBlock(block, window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      dispatch({ type: 'clearFlash' })
    }
  }, [folded, layers, anchor, flash, dispatch])

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-col" data-fold-level={level}>
      {surfaces.overlay && view && level !== 'full' && (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- handler only stops propagation or handles pointer for an enclosing widget; keyboard path is on the child control
        <section
          ref={overlayRef}
          tabIndex={-1}
          aria-label={t('fold.view.aria', { level: t(`fold.level.${level}`) })}
          onKeyDown={(event) => {
            if (!isTypingKey(event)) return
            typingParagraph.current = overlayRef.current
              ? firstVisibleParagraph(overlayRef.current)
              : null
            if (event.key.length === 1 && !event.nativeEvent.isComposing) {
              event.preventDefault()
              pendingText.current = event.key
            }
            setLevel('full')
          }}
          className={cn(
            'flex min-h-screen flex-col bg-background outline-none',
            surfaces.incoming === 'overlay' && cn('relative z-10', INCOMING),
            surfaces.incoming === 'editor' && 'absolute inset-x-0 top-0 z-0'
          )}
          data-testid="note-fold-overlay"
        >
          <FoldBody view={view} dispatch={dispatch} />
          {layers && (
            <FoldPill
              layers={layers}
              level={level}
              openCount={state.opened.size}
              onSelectLevel={setLevel}
              onStep={step}
              onRetry={retry}
              onCopy={() => navigator.clipboard.writeText(foldedMarkdown(view))}
            />
          )}
        </section>
      )}
      <div
        className={cn(
          !surfaces.editor && 'hidden',
          surfaces.incoming === 'overlay' && 'pointer-events-none absolute inset-x-0 top-0 z-0',
          surfaces.incoming === 'editor' && cn('relative z-10 bg-background', INCOMING)
        )}
        // An absolutely placed outgoing editor is already display-only.
        aria-hidden={folded || undefined}
      >
        {children}
      </div>
    </div>
  )
}
