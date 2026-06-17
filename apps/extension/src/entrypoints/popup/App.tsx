import { useEffect, useReducer } from 'react'
import type { ArticleCapture } from '@memry/article-extract'
import type { CaptureResponse, ExtractResponse, PairResponse, StatusResponse } from '@/lib/messages'
import { initialState, reducer, selectPhase } from '@/lib/popup-state'
import { StatusStrip } from '@/components/StatusStrip'
import { EditableTitle } from '@/components/EditableTitle'
import { PropertyRows } from '@/components/PropertyRows'
import { TagEditor } from '@/components/TagEditor'
import { BodyPreview } from '@/components/BodyPreview'
import { ModeSegmented } from '@/components/ModeSegmented'
import { PrimaryButton } from '@/components/PrimaryButton'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const phase = selectPhase(state)

  useEffect(() => {
    browser.runtime
      .sendMessage({ type: 'GET_STATUS' })
      .then((r: StatusResponse) =>
        dispatch({ type: 'STATUS', connection: r.connection, port: r.port })
      )
      .catch(() => dispatch({ type: 'STATUS', connection: 'app-closed', port: null }))

    browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return dispatch({ type: 'DRAFT_READY', draft: null })
      browser.tabs
        .sendMessage(tab.id, { type: 'EXTRACT' })
        .then((r: ExtractResponse) =>
          dispatch({ type: 'DRAFT_READY', draft: r.ok ? r.capture : null })
        )
        .catch(() => dispatch({ type: 'DRAFT_READY', draft: null }))
    })
  }, [])

  const setDraft = (draft: ArticleCapture) => dispatch({ type: 'EDIT', draft })

  const onPair = () => {
    dispatch({ type: 'PAIR_START' })
    window.open('memry://pair') // desktop shows confirm + opens the 120s claim window
    browser.runtime
      .sendMessage({ type: 'START_PAIR' })
      .then((r: PairResponse) => dispatch({ type: 'PAIR_DONE', ok: r.ok }))
      .catch(() => dispatch({ type: 'PAIR_DONE', ok: false }))
  }

  const onSave = () => {
    if (!state.draft) return
    dispatch({ type: 'SAVE_START' })
    browser.runtime
      .sendMessage({ type: 'CAPTURE', capture: state.draft })
      .then((r: CaptureResponse) => dispatch({ type: 'SAVE_DONE', result: r }))
      .catch(() => dispatch({ type: 'SAVE_DONE', result: { ok: false, error: 'network' } }))
  }

  const draft = state.draft
  const editable = phase === 'ready' || phase === 'error'

  return (
    <div className="flex flex-col bg-background font-sans text-foreground">
      <StatusStrip phase={phase} />

      {phase === 'extracting' && (
        <div className="px-4 py-8 text-center text-[13px] text-text-tertiary">
          Reading this page…
        </div>
      )}

      {phase !== 'extracting' && phase !== 'saved' && (
        <div
          className={
            'flex flex-col gap-2 px-4 py-3 ' +
            (phase === 'ready' || phase === 'error' ? '' : 'opacity-60')
          }
        >
          {draft && (
            <>
              <EditableTitle
                value={draft.properties.title}
                disabled={!editable}
                onChange={(title) =>
                  setDraft({ ...draft, properties: { ...draft.properties, title } })
                }
              />
              {draft.extractionStatus === 'failed' && (
                <p className="text-[12px] text-text-tertiary">
                  Couldn't read this page — saving the link and title.
                </p>
              )}
              <PropertyRows
                properties={draft.properties}
                disabled={!editable}
                onChange={(properties) => setDraft({ ...draft, properties })}
              />
              <TagEditor
                tags={draft.properties.tags}
                disabled={!editable}
                onChange={(tags) =>
                  setDraft({ ...draft, properties: { ...draft.properties, tags } })
                }
              />
              <ModeSegmented />
              <BodyPreview markdown={draft.contentMarkdown} />
            </>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        {phase === 'error' && state.errorMessage && (
          <p className="text-[12px] text-text-secondary">{state.errorMessage}</p>
        )}
        {phase === 'app-closed' && (
          <p className="text-[12px] text-text-secondary">Open Memry to capture this page.</p>
        )}
        {phase === 'saved' && (
          <p className="py-2 text-center text-[14px] font-medium text-foreground">
            Added to inbox ✓
          </p>
        )}

        {phase === 'needs-pairing' && <PrimaryButton label="Pair with Memry" onClick={onPair} />}
        {phase === 'pairing' && <PrimaryButton label="Confirm pairing in Memry…" disabled />}
        {phase === 'ready' && (
          <PrimaryButton label="Add to Memry" onClick={onSave} disabled={!draft} />
        )}
        {phase === 'saving' && <PrimaryButton label="Adding…" disabled />}
        {phase === 'app-closed' && <PrimaryButton label="Add to Memry" disabled />}
        {phase === 'error' && (
          <PrimaryButton label="Try again" onClick={() => dispatch({ type: 'RETRY' })} />
        )}
      </div>
    </div>
  )
}
