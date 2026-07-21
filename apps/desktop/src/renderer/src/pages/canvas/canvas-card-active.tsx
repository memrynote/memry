/**
 * CanvasCardActive — the single active card. pointer-events:auto so it captures
 * input; keydown/keyup are swallowed so Cmd/Ctrl+Z belongs to the mounted
 * editor (not Excalidraw), and Escape closes the editor. Tasks 5–7 replace the
 * per-type placeholder with the real note/task/event editors.
 */
import React, { useCallback, useEffect, useRef } from 'react'
import type { CanvasCardRef } from './canvas-cards'
import type { CanvasEntityState } from './use-canvas-entities'

interface CanvasCardActiveProps {
  cardRef: CanvasCardRef
  state: CanvasEntityState | undefined
  onDeactivate: () => void
}

export const CanvasCardActive = ({
  cardRef,
  onDeactivate
}: CanvasCardActiveProps): React.JSX.Element => {
  const editorRef = useRef<HTMLDivElement>(null)
  // Focus the editor on activation so keyboard events target this card (and
  // its onKeyDown below) instead of whatever had focus before the dblclick —
  // otherwise Escape/Cmd+Z never reach this container at all.
  useEffect(() => {
    editorRef.current?.focus()
  }, [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      // Keep editor shortcuts (undo/redo/formatting) from reaching Excalidraw.
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        onDeactivate()
      }
    },
    [onDeactivate]
  )
  const onKeyUp = useCallback((e: React.KeyboardEvent): void => e.stopPropagation(), [])

  return (
    <div
      data-canvas-active-card={cardRef.elementId}
      data-canvas-card-id={cardRef.elementId}
      data-canvas-card-entity={`${cardRef.entityType}:${cardRef.entityId}`}
      data-canvas-card-state="active"
      className="flex h-full w-full flex-col overflow-hidden rounded-md border border-primary bg-white text-start shadow-md dark:bg-zinc-900"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {/* Placeholder editor — replaced by note/task/event editors in Tasks 5–7. */}
      <div
        ref={editorRef}
        data-canvas-active-editor={cardRef.entityType}
        contentEditable
        suppressContentEditableWarning
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto p-3 text-[13px] outline-none"
      />
    </div>
  )
}
