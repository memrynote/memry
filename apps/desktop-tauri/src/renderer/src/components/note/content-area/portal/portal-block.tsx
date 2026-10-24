/**
 * The portal block: a live window onto another note, one block of it, or the
 * blocks a search finds.
 *
 * Like the view block, it is not a block type of its own. In the document it
 * is a `codeBlock` whose `language` is `memry-portal` and whose text is the
 * definition as JSON (`@memry/shared/portal-block`); `createMemrySchema`'s
 * `codeBlockViews` routes that one language here and every other code block
 * renders as code. Main, the phone and an older build hold it as the code
 * block it is on disk.
 *
 * The definition stays in the document as the node's content. It is shown, and
 * editable as JSON, while the caret is in the block or the definition cannot
 * be read; otherwise the portal's own controls (toolbar, fold chevrons, hidden
 * counts) rewrite it.
 *
 * @module note/content-area/portal/portal-block
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { NodeSelection } from '@tiptap/pm/state'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import { PORTAL_BLOCK_LANGUAGE, type ParsedPortal } from '@memry/shared/portal-block'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { PortalInstanceContext } from './portal-context'
import { usePortalKeysPlugin, type PortalKeysEditor } from './portal-keys-plugin'
import { PortalNoteView } from './portal-note-view'
import { PortalSearchView } from './portal-search-view'
import { usePortalDefinition, type PortalEditorLike } from './portal-definition'
import './portal-block.css'

interface PortalBlockNode {
  id: string
  props: { language: string }
  content?: unknown
}

interface PortalBlockEditor extends PortalEditorLike, PortalKeysEditor {
  focus: () => void
  getTextCursorPosition: () => { block: { id: string } }
  onSelectionChange: (callback: () => void) => () => void
  _tiptapEditor?: { state: { selection: unknown } }
}

/**
 * The portal is selected as one block (Backspace at the start of its first
 * root selects it, so the next Backspace removes it whole). BlockNote then
 * also reports the caret as inside the block, so this is read first.
 */
function useSelectedAsBlock(editor: PortalBlockEditor, blockId: string): boolean {
  const read = useCallback((): boolean => {
    const selection = editor._tiptapEditor?.state.selection
    return selection instanceof NodeSelection && selection.node.attrs.id === blockId
  }, [editor, blockId])
  const subscribe = useCallback(
    (onChange: () => void) => editor.onSelectionChange(onChange),
    [editor]
  )
  return useSyncExternalStore(subscribe, read)
}

function useCaretInBlock(editor: PortalBlockEditor, blockId: string): boolean {
  const read = useCallback((): boolean => {
    try {
      return editor.getTextCursorPosition().block.id === blockId
    } catch {
      return false
    }
  }, [editor, blockId])
  const subscribe = useCallback(
    (onChange: () => void) => editor.onSelectionChange(onChange),
    [editor]
  )
  const inside = useSyncExternalStore(subscribe, read)

  // The caret moves in while the definition is still hidden, so the DOM
  // selection ProseMirror set in the same transaction has nowhere to go. Once
  // the definition is on screen, write the selection to the DOM again. Only on
  // the way in: a block that mounts with the caret inside (a tab switch) must
  // not take focus from wherever it is.
  const wasInside = useRef(inside)
  useLayoutEffect(() => {
    if (inside && !wasInside.current) editor.focus()
    wasInside.current = inside
  }, [editor, inside])

  return inside
}

/**
 * The frame is not the node's content, but the node is a selectable textblock:
 * a press anywhere in it would put the caret in the hidden definition. The
 * frame claims its presses by cancelling the default, which ProseMirror
 * honours (`eventBelongsToView`). The live window is the exception: it is an
 * editor of its own and needs its presses.
 */
function useClaimPresses(frameRef: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return undefined
    const claim = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('[data-portal-window]')) return
      event.preventDefault()
    }
    frame.addEventListener('mousedown', claim)
    return () => frame.removeEventListener('mousedown', claim)
  }, [frameRef])
}

function problemMessage(parsed: ParsedPortal, t: (key: string) => string): string | null {
  if (parsed.ok) return null
  if (parsed.reason === 'empty') return t('portalBlock.noTarget')
  return parsed.reason === 'json' ? t('portalBlock.invalidJson') : t('portalBlock.invalidShape')
}

export function PortalBlockRenderer({
  block,
  editor,
  contentRef
}: {
  block: PortalBlockNode
  editor: PortalBlockEditor
  contentRef: (node: HTMLElement | null) => void
}): React.JSX.Element {
  const { t } = useT('common')
  const parsed = usePortalDefinition(block.content)
  const selected = useSelectedAsBlock(editor, block.id)
  const caretInside = useCaretInBlock(editor, block.id) && !selected
  const frameRef = useRef<HTMLDivElement>(null)
  useClaimPresses(frameRef)
  usePortalKeysPlugin(editor)
  // One id per mounted draw of this block: the same block can be drawn by several editors.
  const instanceId = useId()

  const target = parsed.ok ? parsed.definition.target : null
  const body = useMemo(() => {
    if (!parsed.ok || !target) return null
    if (target.kind === 'search') {
      return (
        <PortalSearchView
          blockId={block.id}
          editor={editor}
          definition={parsed.definition}
          target={target}
        />
      )
    }
    return (
      <PortalNoteView
        blockId={block.id}
        editor={editor}
        definition={parsed.definition}
        target={target}
        selected={selected}
      />
    )
  }, [parsed, target, block.id, editor, selected])

  // A block whose language was changed out from under a live portal (undo, a
  // synced edit) is a plain code block again until the node view is rebuilt.
  if (block.props.language !== PORTAL_BLOCK_LANGUAGE) {
    return (
      <pre>
        <code ref={contentRef} />
      </pre>
    )
  }

  const problem = problemMessage(parsed, t)
  const showSource = caretInside || problem !== null

  return (
    <PortalInstanceContext.Provider value={instanceId}>
      <div className="memry-portal-block my-1 w-full" data-memry-portal="">
        <div ref={frameRef} contentEditable={false}>
          {body}
          {problem ? (
            <p className="pb-1 text-xs text-destructive" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <div className={cn('memry-portal-block-source mt-1.5', !showSource && 'hidden')}>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[0.8125rem]">
            <code ref={contentRef} />
          </pre>
        </div>
      </div>
    </PortalInstanceContext.Provider>
  )
}

/**
 * The spec whose render `codeBlockViews` routes `memry-portal` code blocks to
 * (`editor-schema.ts` takes `.implementation.render` from it).
 *
 * The config is the code block's own, so BlockNote's React wrapper stamps the
 * same `data-content-type` and `data-language` a plain code block gets. Only
 * the render is used; the node and its parse rules stay the code block's.
 */
export const createPortalBlockSpec = createReactBlockSpec(
  {
    type: 'codeBlock' as const,
    propSchema: {
      language: { default: memryCodeBlockOptions.defaultLanguage ?? 'text' }
    },
    content: 'plain' as const
  },
  {
    render: (props) => (
      <PortalBlockRenderer
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- BlockNote's block/editor generics are far wider than the structural view the portal reads
        block={props.block as unknown as PortalBlockNode}
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- BlockNote's block/editor generics are far wider than the structural view the portal reads
        editor={props.editor as unknown as PortalBlockEditor}
        contentRef={props.contentRef}
      />
    )
  }
)
