import { useCallback, useEffect, useRef } from 'react'

import type { Editor } from '@tiptap/core'
import { NodeSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { isTextSelection } from '@tiptap/core'
import { BubbleMenu } from '@tiptap/react/menus'

import { Bold, Code, Italic, Strikethrough, Underline } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

/**
 * Marks the toolbar so the composer's outside-pointerdown auto-cancel can tell
 * a toolbar click from a click that should discard the draft. The toolbar is
 * portalled to the body, so it is outside the composer subtree.
 */
export const COMMENT_FORMAT_TOOLBAR_ATTR = 'data-comment-format-toolbar'

interface CommentFormatItem {
  id: string
  markName: string
  labelKey: string
  Icon: typeof Bold
  run: (editor: Editor) => void
}

export const COMMENT_FORMAT_ITEMS: CommentFormatItem[] = [
  {
    id: 'bold',
    markName: 'bold',
    labelKey: 'comments.format.bold',
    Icon: Bold,
    run: (editor) => editor.chain().focus().toggleBold().run()
  },
  {
    id: 'italic',
    markName: 'italic',
    labelKey: 'comments.format.italic',
    Icon: Italic,
    run: (editor) => editor.chain().focus().toggleItalic().run()
  },
  {
    id: 'underline',
    markName: 'underline',
    labelKey: 'comments.format.underline',
    Icon: Underline,
    run: (editor) => editor.chain().focus().toggleUnderline().run()
  },
  {
    id: 'strike',
    markName: 'strike',
    labelKey: 'comments.format.strike',
    Icon: Strikethrough,
    run: (editor) => editor.chain().focus().toggleStrike().run()
  },
  {
    id: 'code',
    markName: 'code',
    labelKey: 'comments.format.code',
    Icon: Code,
    run: (editor) => editor.chain().focus().toggleCode().run()
  }
]

export function shouldShowCommentFormatToolbar({
  isEditable,
  element,
  state,
  suppressed,
  hasFocus
}: {
  isEditable: boolean
  element: Element | null
  state: Pick<EditorState, 'selection' | 'doc'>
  suppressed: boolean
  hasFocus: boolean
}): boolean {
  // The mention picker owns the selection while it is open.
  if (suppressed) return false
  if (!isEditable) return false

  const { selection } = state
  if (selection.empty) return false
  // Clicking an @mention chip selects the atom node — non-empty, but there is
  // nothing to format.
  if (selection instanceof NodeSelection) return false
  if (!isTextSelection(selection)) return false
  if (!state.doc.textBetween(selection.from, selection.to, ' ').trim()) return false

  // Stay open while focus is inside the bubble itself (keyboard users).
  const activeElement = element?.ownerDocument?.activeElement ?? null
  return hasFocus || Boolean(activeElement && element?.contains(activeElement))
}

export function CommentFormatButtons({ editor }: { editor: Editor }): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <div
      className="critic-comment-format-row"
      // The bubble sits outside the contenteditable, so a plain mousedown moves
      // focus and collapses the selection before the command can run.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => event.preventDefault()}
    >
      {COMMENT_FORMAT_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className="critic-comment-format-button"
          data-test={`comment-format-${item.id}`}
          aria-label={t(item.labelKey)}
          aria-pressed={editor.isActive(item.markName)}
          tabIndex={-1}
          onClick={() => item.run(editor)}
        >
          <item.Icon className="size-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}

export function CommentFormatToolbar({
  editor,
  suppressed
}: {
  editor: Editor
  suppressed: boolean
}): React.JSX.Element {
  const { t } = useT('notes')
  // The plugin captures `shouldShow` once, so the live value has to come
  // through a ref rather than the closure.
  const suppressedRef = useRef(suppressed)
  suppressedRef.current = suppressed

  const elementRef = useRef<HTMLDivElement | null>(null)
  const setMenuElement = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element
    // `restProps` land on the inner portalled div; the node actually appended to
    // the body is the plugin's own wrapper. Tag both so `closest()` finds one.
    element?.setAttribute(COMMENT_FORMAT_TOOLBAR_ATTR, '')
    element?.parentElement?.setAttribute(COMMENT_FORMAT_TOOLBAR_ATTR, '')
  }, [])

  const shouldShow = useCallback(
    ({ state, view }: { state: EditorState; view: EditorView }) =>
      shouldShowCommentFormatToolbar({
        isEditable: editor.isEditable,
        element: elementRef.current,
        state,
        suppressed: suppressedRef.current,
        hasFocus: view.hasFocus()
      }),
    [editor]
  )

  // The rail, the flyout and the editor are three separate scroll containers and
  // `scroll` does not bubble, so the plugin's single window listener misses two
  // of them. Capture phase catches all three.
  useEffect(() => {
    let frame = 0
    const reposition = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (editor.isDestroyed) return
        editor.view.dispatch(editor.state.tr.setMeta('bubbleMenu', 'updatePosition'))
      })
    }

    window.addEventListener('scroll', reposition, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [editor])

  // Escape closes the bubble before the composer's own Escape cancels the draft.
  useEffect(() => {
    const dom = editor.view.dom
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (!elementRef.current?.isConnected) return
      event.stopPropagation()
      editor.commands.setTextSelection(editor.state.selection.to)
    }

    dom.addEventListener('keydown', handleKeyDown, true)
    return () => dom.removeEventListener('keydown', handleKeyDown, true)
  }, [editor])

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="commentFormatToolbar"
      updateDelay={100}
      appendTo={() => document.body}
      shouldShow={shouldShow}
      options={{
        strategy: 'fixed',
        placement: 'top',
        offset: 8,
        flip: {},
        shift: { padding: 8 },
        hide: true
      }}
      ref={setMenuElement}
      role="toolbar"
      aria-label={t('comments.formatToolbarAria')}
      aria-orientation="horizontal"
      className="critic-comment-format-toolbar"
    >
      <CommentFormatButtons editor={editor} />
    </BubbleMenu>
  )
}
