/**
 * CanvasCardActive — the single active card. pointer-events:auto so it captures
 * input; keydown/keyup are swallowed so Cmd/Ctrl+Z belongs to the mounted
 * editor (not Excalidraw), and Escape closes the editor. Note cards render the
 * real note editor (Task 5); task cards render the slim task editor (Task 6);
 * event cards keep the placeholder until Task 7 replaces it.
 */
import React, { useCallback, useEffect, useRef } from 'react'
import type { CanvasCardRef } from './canvas-cards'
import type { CanvasEntityState } from './use-canvas-entities'
import { EmbeddedNoteEditor } from './embedded-note-editor'
import { CanvasTaskEditor } from './canvas-task-editor'

interface CanvasCardActiveProps {
  cardRef: CanvasCardRef
  state: CanvasEntityState | undefined
  onDeactivate: () => void
}

export const CanvasCardActive = ({
  cardRef,
  onDeactivate
}: CanvasCardActiveProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement>(null)
  // Focus the container on activation so keyboard events target this card
  // (and its onKeyDown below) instead of whatever had focus before the
  // dblclick — otherwise Escape/Cmd+Z never reach this container at all. This
  // must live on the outer container (not the per-type editor inside) since
  // the note branch mounts BlockNote, which owns its own focus.
  useEffect(() => {
    containerRef.current?.focus()
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
      ref={containerRef}
      tabIndex={-1}
      data-canvas-active-card={cardRef.elementId}
      data-canvas-card-id={cardRef.elementId}
      data-canvas-card-entity={`${cardRef.entityType}:${cardRef.entityId}`}
      data-canvas-card-state="active"
      className="flex h-full w-full flex-col overflow-hidden rounded-md border border-primary bg-white text-start shadow-md outline-none dark:bg-zinc-900"
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {cardRef.entityType === 'note' ? (
        <EmbeddedNoteEditor noteId={cardRef.entityId} />
      ) : cardRef.entityType === 'task' ? (
        <CanvasTaskEditor taskId={cardRef.entityId} />
      ) : (
        // Placeholder editor — replaced by the event editor in Task 7.
        <div
          data-canvas-active-editor={cardRef.entityType}
          contentEditable
          suppressContentEditableWarning
          className="min-h-0 flex-1 overflow-auto p-3 text-[13px] outline-none"
        />
      )}
    </div>
  )
}
