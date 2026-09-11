import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Copy } from 'lucide-react'
import { useBlockNoteEditor, useEditorSelectionChange } from '@blocknote/react'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import { useT } from '@memry/i18n/renderer'

/**
 * One toolbar in a code block's block-start / inline-end corner: the language
 * picker and a copy button, in a single pill.
 *
 * BlockNote's own picker is a bare `<select>` pinned to the block's top-LEFT at
 * half opacity in hardcoded white — unreadable on the light theme and nothing
 * about it reads as a control. base.css hides it; this replaces it, so both
 * controls sit in one box instead of at opposite corners.
 *
 * Portalled and fixed-positioned rather than appended into the block: the code
 * block is a ProseMirror node view whose content DOM is the `<pre>`, and DOM
 * ProseMirror did not write is either ignored or wiped on its next redraw.
 * Measuring from outside keeps its DOM untouched.
 *
 * Shown on hover AND while the caret is in the block: hover is not a gesture
 * every user has, and without the second the picker is unreachable by keyboard.
 */

const CODE_BLOCK_SELECTOR = '[data-content-type="codeBlock"]'

/** Marks the toolbar, so the pointer leaving the block for it is not "left". */
const TOOLBAR_ATTR = 'data-memry-code-toolbar'

/** How long the copy button shows the check before falling back to the icon. */
const COPIED_FEEDBACK_MS = 1500

/** Gap from the code block's block-start and inline-end padding edges. */
const OFFSET = 8

interface Placement {
  block: HTMLElement
  top: number
  /** The pill's inline-end edge, as a viewport coordinate. */
  inlineEnd: number
  isRtl: boolean
}

function measure(block: HTMLElement): Placement {
  const rect = block.getBoundingClientRect()
  const isRtl = getComputedStyle(block).direction === 'rtl'
  return {
    block,
    top: rect.top + OFFSET,
    inlineEnd: isRtl ? rect.left + OFFSET : rect.right - OFFSET,
    isRtl
  }
}

interface CodeBlockToolbarProps {
  /** The `.bn-container` the editor renders into. */
  containerEl: HTMLElement | null
}

export const CodeBlockToolbar: FC<CodeBlockToolbarProps> = ({ containerEl }) => {
  const { t } = useT('notes')
  const editor = useBlockNoteEditor()
  const [hovered, setHovered] = useState<HTMLElement | null>(null)
  const [focused, setFocused] = useState<HTMLElement | null>(null)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Bumped on scroll and resize, to re-measure a block that has not changed. */
  const [tick, setTick] = useState(0)
  /**
   * Whether the picker has focus — an open native dropdown among other things.
   * While it does, the pointer bookkeeping must not drop the block: the open
   * list is not part of the page, so the pointer reads as having left, and
   * unmounting the select closes the dropdown before it can be picked from.
   */
  const pickerOpenRef = useRef(false)

  /** Insertion order is the dropdown's order — sorted, Plain Text first. */
  const languages = useMemo(() => Object.entries(memryCodeBlockOptions.supportedLanguages), [])

  const block = hovered ?? focused
  const placement = useMemo(() => {
    void tick
    return block?.isConnected ? measure(block) : null
  }, [block, tick])

  useEffect(() => {
    if (!containerEl) return

    const handlePointerOver = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(`[${TOOLBAR_ATTR}]`)) return

      const next = target.closest(CODE_BLOCK_SELECTOR)
      if (!next && pickerOpenRef.current) return
      setHovered(next instanceof HTMLElement ? next : null)
    }
    const handlePointerLeave = (): void => {
      if (pickerOpenRef.current) return
      setHovered(null)
    }
    const remeasure = (): void => setTick((value) => value + 1)

    containerEl.addEventListener('pointerover', handlePointerOver)
    containerEl.addEventListener('pointerleave', handlePointerLeave)
    window.addEventListener('resize', remeasure)
    // Capture: the editor scrolls in an inner container, whose scroll does not
    // bubble to window.
    window.addEventListener('scroll', remeasure, true)

    return () => {
      containerEl.removeEventListener('pointerover', handlePointerOver)
      containerEl.removeEventListener('pointerleave', handlePointerLeave)
      window.removeEventListener('resize', remeasure)
      window.removeEventListener('scroll', remeasure, true)
    }
  }, [containerEl])

  useEditorSelectionChange(() => {
    const caretBlock = editor.getTextCursorPosition().block
    if (caretBlock.type !== 'codeBlock') {
      setFocused(null)
      return
    }
    // `data-id` sits on the block wrapper on some block types and on the
    // content element itself on others, so try the element and then inside it.
    const wrapper = containerEl?.querySelector(`[data-id="${caretBlock.id}"]`)
    const el = wrapper?.matches(CODE_BLOCK_SELECTOR)
      ? wrapper
      : wrapper?.querySelector(CODE_BLOCK_SELECTOR)
    setFocused(el instanceof HTMLElement ? el : null)
  })

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    },
    []
  )

  const handleCopy = useCallback((): void => {
    const code = placement?.block.querySelector('pre')?.textContent
    if (code === null || code === undefined) return

    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    })
  }, [placement])

  const handleLanguageChange = useCallback(
    (language: string): void => {
      const blockId = placement?.block.closest('[data-id]')?.getAttribute('data-id')
      if (!blockId) return
      editor.updateBlock(blockId, { type: 'codeBlock', props: { language } })
      // The picker reads the block back, and updating it fires no selection
      // change, so nothing else would re-render the toolbar.
      setTick((value) => value + 1)
    },
    [editor, placement]
  )

  if (!containerEl || !placement) return null

  const blockId = placement.block.closest('[data-id]')?.getAttribute('data-id')
  const currentBlock = blockId ? editor.getBlock(blockId) : undefined
  const language =
    currentBlock?.type === 'codeBlock' ? String(currentBlock.props.language ?? '') : ''
  const copyLabel = copied ? t('editor.codeBlock.copied') : t('editor.codeBlock.copy')
  const inlineEndStyle = placement.isRtl
    ? { left: placement.inlineEnd }
    : { left: placement.inlineEnd, transform: 'translateX(-100%)' }

  return createPortal(
    <div
      {...{ [TOOLBAR_ATTR]: '' }}
      className="memry-code-toolbar"
      style={{ top: placement.top, ...inlineEndStyle }}
    >
      {editor.isEditable && (
        <span className="memry-code-toolbar-language">
          <select
            value={language}
            aria-label={t('editor.codeBlock.language')}
            onFocus={() => {
              pickerOpenRef.current = true
            }}
            onBlur={() => {
              pickerOpenRef.current = false
            }}
            onChange={(event) => handleLanguageChange(event.target.value)}
          >
            {languages.map(([key, { name }]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
          <ChevronDown className="size-3" aria-hidden="true" />
        </span>
      )}
      <button
        type="button"
        className="memry-code-toolbar-button"
        aria-label={copyLabel}
        title={copyLabel}
        // Only on the button, never on the pill: preventing the default
        // mousedown keeps the editor from taking focus back and scrolling the
        // caret into view, but on the <select> it also stops the native
        // dropdown from opening at all.
        onMouseDown={(event) => event.preventDefault()}
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </div>,
    containerEl
  )
}
