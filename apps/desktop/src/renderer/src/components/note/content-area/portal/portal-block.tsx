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
 * The definition stays in the document as the node's content, never on screen:
 * the portal's own controls (toolbar, fold chevrons, hidden counts) rewrite it,
 * and the keys plugin keeps the caret out of it.
 *
 * @module note/content-area/portal/portal-block
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { NodeSelection } from '@tiptap/pm/state'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import { PORTAL_BLOCK_LANGUAGE } from '@memry/shared/portal-block'
import { useT } from '@memry/i18n/renderer'
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
  onSelectionChange: (callback: () => void) => () => void
  _tiptapEditor?: { state: { selection: unknown } }
}

/**
 * The portal is selected as one block (Backspace at the start of its first
 * root selects it, so the next Backspace removes it whole).
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

  return (
    <PortalInstanceContext.Provider value={instanceId}>
      <div className="memry-portal-block my-1 w-full" data-memry-portal="">
        <div ref={frameRef} contentEditable={false}>
          {body}
          {parsed.ok ? null : (
            <p className="pb-1 text-xs text-destructive" role="alert">
              {t('portalBlock.unreadable')}
            </p>
          )}
        </div>
        <pre hidden>
          <code ref={contentRef} />
        </pre>
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
