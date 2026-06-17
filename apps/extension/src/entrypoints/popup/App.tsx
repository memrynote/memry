import { useEffect, useReducer, useRef } from 'react'
import type { ArticleCapture } from '@memry/article-extract'
import type {
  CaptureResponse,
  CaptureMode,
  ConnectionState,
  ExtractResponse,
  PairResponse,
  ScreenshotResponse,
  StatusResponse
} from '@/lib/messages'
import { initialState, reducer, selectPhase } from '@/lib/popup-state'
import { buildScreenshotDraft } from '@/lib/capture-modes'
import { StatusStrip } from '@/components/StatusStrip'
import { EditableTitle } from '@/components/EditableTitle'
import { PropertyRows } from '@/components/PropertyRows'
import { TagEditor } from '@/components/TagEditor'
import { BodyPreview } from '@/components/BodyPreview'
import { ModeSegmented } from '@/components/ModeSegmented'
import { ScreenshotPreview } from '@/components/ScreenshotPreview'
import { PrimaryButton } from '@/components/PrimaryButton'

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const phase = selectPhase(state)
  const articleDraftRef = useRef<ArticleCapture | null>(null)

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
        .then((r: ExtractResponse) => {
          articleDraftRef.current = r.ok ? r.capture : null
          dispatch({ type: 'DRAFT_READY', draft: r.ok ? r.capture : null })
        })
        .catch(() => dispatch({ type: 'DRAFT_READY', draft: null }))
    })
  }, [])

  const setDraft = (draft: ArticleCapture) => dispatch({ type: 'EDIT', draft })

  const onSelectMode = async (mode: CaptureMode) => {
    // Re-clicking article is a pure no-op (it would clobber edits with the cached draft),
    // but re-clicking selection/screenshot re-runs the grab — that's the documented retry
    // path ("Select text on the page, then pick Selection again").
    if (mode === state.mode && mode === 'article') return
    dispatch({ type: 'SET_MODE', mode })
    if (mode === 'article') {
      dispatch({ type: 'DRAFT_READY', draft: articleDraftRef.current })
      return
    }
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return dispatch({ type: 'DRAFT_READY', draft: null })
    if (mode === 'selection') {
      const r: ExtractResponse = await browser.tabs
        .sendMessage(tab.id, { type: 'GRAB_SELECTION' })
        .catch(() => ({ ok: false, error: 'network' }))
      dispatch({ type: 'DRAFT_READY', draft: r.ok ? r.capture : null })
    } else {
      const base = articleDraftRef.current
      const r: ScreenshotResponse = await browser.runtime
        .sendMessage({ type: 'GRAB_SCREENSHOT' })
        .catch(() => ({ ok: false, error: 'network' }))
      dispatch({
        type: 'DRAFT_READY',
        draft: r.ok && base ? buildScreenshotDraft(base, r.dataUrl) : null
      })
    }
  }

  const onAdd = async (
    connectionOverride?: ConnectionState
  ): Promise<CaptureResponse | undefined> => {
    if (!state.draft) return
    const connection = connectionOverride ?? state.connection
    // Pair inline if this connection isn't ready yet.
    if (connection === 'needs-pairing') {
      dispatch({ type: 'APPROVE_START' })
      const pair: PairResponse = await browser.runtime
        .sendMessage({ type: 'PAIR' })
        .catch(() => ({ ok: false }))
      dispatch({ type: 'APPROVE_DONE', ok: pair.ok })
      if (!pair.ok) return
    }
    dispatch({ type: 'SAVE_START' })
    const result: CaptureResponse = await browser.runtime
      .sendMessage({ type: 'CAPTURE', capture: state.draft })
      .catch(() => ({ ok: false, error: 'network' }))
    dispatch({ type: 'SAVE_DONE', result })
    return result
  }

  const onAddAndOpen = async () => {
    const result = await onAdd()
    if (result?.ok) {
      browser.tabs
        .create({ url: `memry://open?item=${encodeURIComponent(result.itemId)}` })
        .catch(() => {})
    }
  }

  const onLaunchAndAdd = async () => {
    dispatch({ type: 'LAUNCH_START' })
    browser.tabs.create({ url: 'memry://open' }).catch(() => {})
    const up: { ok: boolean } = await browser.runtime
      .sendMessage({ type: 'WAIT_FOR_SERVER' })
      .catch(() => ({ ok: false }))
    dispatch({ type: 'LAUNCH_DONE', ok: up.ok })
    if (!up.ok) return
    dispatch({ type: 'STATUS', connection: 'needs-pairing', port: null })
    await onAdd('needs-pairing')
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

      {phase === 'capturing' && (
        <div className="px-4 py-8 text-center text-[13px] text-text-tertiary">
          {state.mode === 'screenshot' ? 'Capturing full page…' : 'Reading selection…'}
        </div>
      )}

      {phase !== 'extracting' &&
        phase !== 'capturing' &&
        phase !== 'saved' &&
        phase !== 'queued' && (
          <div
            className={
              'flex flex-col gap-2 px-4 py-3 ' +
              (phase === 'ready' || phase === 'error' ? '' : 'opacity-60')
            }
          >
            <ModeSegmented mode={state.mode} disabled={!editable} onSelect={onSelectMode} />
            {!draft && state.mode === 'selection' && (
              <p className="py-6 text-center text-[12px] text-text-tertiary">
                Select text on the page, then pick Selection again.
              </p>
            )}
            {!draft && state.mode === 'screenshot' && (
              <p className="py-6 text-center text-[12px] text-text-tertiary">
                Couldn't capture this page.
              </p>
            )}
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
                {state.mode === 'screenshot' && draft.screenshotDataUrl ? (
                  <ScreenshotPreview dataUrl={draft.screenshotDataUrl} />
                ) : (
                  <BodyPreview markdown={draft.contentMarkdown} />
                )}
              </>
            )}
          </div>
        )}

      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        {phase === 'error' && state.errorMessage && (
          <p className="text-[12px] text-text-secondary">{state.errorMessage}</p>
        )}
        {phase === 'app-closed' && (
          <p className="text-[12px] text-text-secondary">
            Memry isn't running — click below to launch it.
          </p>
        )}
        {phase === 'saved' && (
          <p className="py-2 text-center text-[14px] font-medium text-foreground">
            Added to inbox ✓
          </p>
        )}
        {phase === 'queued' && (
          <p className="py-2 text-center text-[14px] font-medium text-foreground">
            Saved offline — syncs when Memry opens ✓
          </p>
        )}

        {phase === 'ready' && (
          <div className="flex flex-col gap-2">
            <PrimaryButton label="Add to Memry" onClick={() => onAdd()} disabled={!draft} />
            <button
              type="button"
              disabled={!draft}
              onClick={onAddAndOpen}
              className="rounded-md border border-border px-3 py-2 text-[13px] font-medium text-text-secondary disabled:opacity-50"
            >
              Add &amp; open in Memry
            </button>
          </div>
        )}
        {phase === 'approving' && <PrimaryButton label="Approve in Memry…" disabled />}
        {phase === 'saving' && <PrimaryButton label="Adding…" disabled />}
        {phase === 'app-closed' && (
          <PrimaryButton label="Open Memry & save" onClick={onLaunchAndAdd} />
        )}
        {phase === 'launching' && <PrimaryButton label="Opening Memry…" disabled />}
        {phase === 'error' && (
          <PrimaryButton label="Try again" onClick={() => dispatch({ type: 'RETRY' })} />
        )}
      </div>
    </div>
  )
}
