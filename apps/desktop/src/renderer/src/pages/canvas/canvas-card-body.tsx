/**
 * CanvasCardBody — the one body an item card renders, in both states.
 *
 * The idle card and the active card mount the SAME component tree; `interactive`
 * only decides whether the leaves are writable. That is what makes the
 * double-click a no-op visually: there is no "preview" layout to swap out, so
 * nothing can shift, resize, or re-typeset when a card becomes editable.
 *
 * Notes are the one asymmetry: editing needs <ContentArea> (Yjs binding, task
 * auto-conversion, upload handling), while an idle card only needs to paint, so
 * it mounts the light read-only editor in canvas-note-body.tsx. Both render
 * through `editorSchema`, so the output matches.
 */

import React from 'react'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { useT } from '@memry/i18n/renderer'
import type { CanvasCardRef } from './canvas-cards'
import type { CanvasEntityState } from './use-canvas-entities'
import { CanvasNoteBody } from './canvas-note-body'
import { EmbeddedNoteEditor } from './embedded-note-editor'
import { CanvasTaskEditor } from './canvas-task-editor'
import { CanvasEventEditor } from './canvas-event-editor'

interface NoteCardHeaderProps {
  emoji: string | null
  title: string
}

/**
 * The note's icon + title. ContentArea renders only the body, so the header is
 * drawn here for BOTH states — otherwise the title would vanish on activation,
 * which is exactly the mode-switch this design removes.
 */
const NoteCardHeader = ({ emoji, title }: NoteCardHeaderProps): React.JSX.Element => {
  const { t } = useT('common')
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-3 pt-3">
      {emoji ? (
        <NoteIconDisplay
          value={emoji}
          className="flex size-4 shrink-0 items-center justify-center text-sm"
        />
      ) : null}
      <h3 className="truncate text-[13px] font-semibold text-foreground">
        {title || t('canvas.card.untitled')}
      </h3>
    </div>
  )
}

interface CanvasCardBodyProps {
  cardRef: CanvasCardRef
  state: CanvasEntityState | undefined
  /** False on an idle card: same tree, read-only leaves. */
  interactive: boolean
  /** Active event cards close themselves after save/dismiss. */
  onDone?: () => void
}

export const CanvasCardBody = ({
  cardRef,
  state,
  interactive,
  onDone
}: CanvasCardBodyProps): React.JSX.Element => {
  if (cardRef.entityType === 'note') {
    const note = state?.status === 'ready' && state.kind === 'note' ? state : null
    return (
      <>
        <NoteCardHeader emoji={note?.emoji ?? null} title={note?.title ?? ''} />
        {/*
          The inset lives here, on the wrapper both states share, so activation
          cannot reflow a single line. It cannot live inside the editors: the app
          zeroes `.bn-editor` padding-inline globally, which left note prose flush
          against the card's rounded border on every side. px-3 also lines the
          body up with the header title above it.
        */}
        <div data-canvas-note-content="" className="flex min-h-0 flex-1 flex-col px-3 pb-3">
          {interactive ? (
            <EmbeddedNoteEditor noteId={cardRef.entityId} />
          ) : (
            <CanvasNoteBody markdown={note?.body ?? ''} noteId={cardRef.entityId} />
          )}
        </div>
      </>
    )
  }

  if (cardRef.entityType === 'task') {
    return <CanvasTaskEditor taskId={cardRef.entityId} interactive={interactive} />
  }

  return (
    <CanvasEventEditor
      eventId={cardRef.entityId}
      interactive={interactive}
      onDone={onDone ?? ((): void => {})}
    />
  )
}
