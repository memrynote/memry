import { useEffect, useReducer, useRef } from 'react'
import type { ArticleCapture } from '@memry/article-extract'
import type {
  CaptureResponse,
  ConnectionState,
  ExtractResponse,
  FetchPdfResponse,
  PairResponse,
  StatusResponse
} from '@/lib/messages'
import { initialState, reducer, selectPhase } from '@/lib/popup-state'
import { ensureCapturePermissions } from '@/lib/capture-permissions'
import { buildPdfDraft } from '@/lib/pdf-capture'
import { EditableTitle } from '@/components/EditableTitle'
import { PropertyRows } from '@/components/PropertyRows'
import { TagEditor } from '@/components/TagEditor'
import { PrimaryButton } from '@/components/PrimaryButton'
import { ThemeToggle } from '@/components/ThemeToggle'

const isMac = navigator.platform.toLowerCase().includes('mac')
const SUBMIT_HINT = isMac ? '⌘ ↵' : 'Ctrl ↵'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// Render captured page HTML as plain text — never inject untrusted page markup
// into the extension popup's DOM (XSS).
function stripHtml(html: string): string {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? ''
}

const STATUS: Record<ConnectionState, { tone: string; label: string }> = {
  ready: { tone: 'bg-ready', label: 'Connected to Memry' },
  'needs-pairing': { tone: 'bg-ready', label: 'Ready — first save pairs with Memry' },
  'app-closed': { tone: 'bg-text-tertiary', label: 'Memry is closed — saving opens it' }
}

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
      // Content scripts never inject into a PDF viewer, so a rejected EXTRACT on
      // an http(s) tab means the browser is showing a binary — treat it as a PDF.
      // buildPdfDraft returns null for chrome://, file:// and the Web Store, which
      // keeps today's "Couldn't read this page" state for those.
      const pdfFallback = () => buildPdfDraft({ url: tab.url, title: tab.title })
      browser.tabs
        .sendMessage(tab.id, { type: 'EXTRACT' })
        .then((r: ExtractResponse) =>
          dispatch({ type: 'DRAFT_READY', draft: r.ok ? r.capture : pdfFallback() })
        )
        .catch(() => dispatch({ type: 'DRAFT_READY', draft: pdfFallback() }))
    })
  }, [])

  const setDraft = (draft: ArticleCapture) => dispatch({ type: 'EDIT', draft })

  // Probe the desktop app again. The mount probe may have run while the Firefox
  // host permission was still blocked and cached a stale 'app-closed'.
  const fetchStatus = async (): Promise<StatusResponse> => {
    try {
      return (await browser.runtime.sendMessage({ type: 'GET_STATUS' })) as StatusResponse
    } catch {
      return { connection: 'app-closed', port: null }
    }
  }

  const onAdd = async (
    connectionOverride?: ConnectionState,
    draftOverride?: ArticleCapture
  ): Promise<CaptureResponse | undefined> => {
    const draft = draftOverride ?? state.draft
    if (!draft) return
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
      .sendMessage({ type: 'CAPTURE', capture: draft })
      .catch(() => ({ ok: false, error: 'network' }))
    dispatch({ type: 'SAVE_DONE', result })
    // Flash a "Sent" confirmation, then close. Offline-queued / error stay open.
    if (result.ok) setTimeout(() => window.close(), 600)
    return result
  }

  const onLaunchAndAdd = async (draftOverride?: ArticleCapture) => {
    const draft = draftOverride ?? state.draft
    dispatch({ type: 'LAUNCH_START' })
    browser.tabs.create({ url: 'memry://open' }).catch(() => {})
    const up: { ok: boolean } = await browser.runtime
      .sendMessage({ type: 'WAIT_FOR_SERVER' })
      .catch(() => ({ ok: false }))
    if (up.ok) {
      dispatch({ type: 'LAUNCH_DONE', ok: true })
      const status = await fetchStatus()
      dispatch({ type: 'STATUS', connection: status.connection, port: status.port })
      await onAdd(
        status.connection === 'app-closed' ? 'needs-pairing' : status.connection,
        draft ?? undefined
      )
      return
    }
    // The server never came up in time. Don't drop the draft — hand it to the
    // background, which queues it for the retry alarm (the badge shows the
    // count) instead of losing it when the popup closes.
    if (!draft) {
      dispatch({ type: 'LAUNCH_DONE', ok: false })
      return
    }
    dispatch({ type: 'SAVE_START' })
    const result: CaptureResponse = await browser.runtime
      .sendMessage({ type: 'CAPTURE', capture: draft })
      .catch(() => ({ ok: false, error: 'network' }))
    dispatch({ type: 'SAVE_DONE', result })
    // Mirror onAdd: if the server came up between the timeout and this CAPTURE,
    // flash "Sent" and close. Offline-queued / error stay open.
    if (result.ok) setTimeout(() => window.close(), 600)
  }

  // One button. Request every origin this capture needs in a single prompt — a
  // second, await-separated request loses the gesture on Firefox. Then re-probe:
  // the mount probe may have been blocked by the missing loopback permission.
  const onSend = async () => {
    let draft = state.draft
    if (!(await ensureCapturePermissions(draft?.mode === 'pdf' ? draft.url : null))) {
      dispatch({ type: 'SAVE_DONE', result: { ok: false, error: 'permission-denied' } })
      return
    }
    // Pull the PDF bytes before touching the desktop app, so a failed fetch never
    // launches Memry for a capture that cannot be sent. The result is threaded
    // through as an argument, not dispatched: this closure's `state` is frozen.
    if (draft?.mode === 'pdf' && !draft.pdfDataUrl) {
      dispatch({ type: 'SAVE_START' })
      const pdf: FetchPdfResponse = await browser.runtime
        .sendMessage({ type: 'FETCH_PDF', url: draft.url })
        .catch(() => ({ ok: false, error: 'pdf-fetch-failed' }) as FetchPdfResponse)
      if (!pdf.ok) {
        dispatch({ type: 'SAVE_DONE', result: { ok: false, error: pdf.error } })
        return
      }
      draft = { ...draft, pdfDataUrl: pdf.dataUrl, pdfFilename: pdf.filename }
    }
    const status = await fetchStatus()
    dispatch({ type: 'STATUS', connection: status.connection, port: status.port })
    if (status.connection === 'app-closed') {
      await onLaunchAndAdd(draft ?? undefined)
    } else {
      await onAdd(status.connection, draft ?? undefined)
    }
  }

  // ⌘↵ / Ctrl↵ saves when the card is ready. Ref keeps the handler fresh
  // without re-subscribing the listener on every render.
  const sendRef = useRef(onSend)
  sendRef.current = onSend
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === 'Enter' &&
        (phase === 'ready' || phase === 'app-closed')
      ) {
        e.preventDefault()
        sendRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase])

  const draft = state.draft
  const editable = phase === 'ready' || phase === 'error' || phase === 'app-closed'
  const isCard = phase !== 'extracting' && phase !== 'queued'
  const status =
    state.connection === 'unknown' ? STATUS.ready : STATUS[state.connection as ConnectionState]

  return (
    <div className="flex max-h-[600px] flex-col bg-background font-sans text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface-strong px-4 py-2.5">
        <div className="flex items-center gap-2">
          <img src="/icon/32.png" alt="" className="size-5 rounded-[6px]" aria-hidden />
          <span className="text-[13px] font-semibold tracking-tight text-foreground">
            memrynote
          </span>
        </div>
        <div className="flex items-center gap-2">
          {state.connection !== 'app-closed' && (
            <div className="flex items-center gap-1.5" title={status.label}>
              <span className={`size-1.5 rounded-full ${status.tone}`} aria-hidden />
              <span className="text-[11px] font-medium text-text-tertiary">Inbox</span>
              <span className="sr-only">{status.label}</span>
            </div>
          )}
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {phase === 'extracting' && (
          <div className="flex flex-col gap-3 px-4 py-4" aria-live="polite" aria-busy>
            <div className="h-3 w-20 rounded bg-surface-active" />
            <div className="h-5 w-3/4 rounded bg-surface-active" />
            <div className="flex flex-col gap-1.5">
              <div className="h-3 w-full rounded bg-surface-active" />
              <div className="h-3 w-11/12 rounded bg-surface-active" />
              <div className="h-3 w-2/3 rounded bg-surface-active" />
            </div>
            <span className="sr-only">Reading this page…</span>
          </div>
        )}

        {phase === 'queued' && (
          <div className="rise-in flex flex-col items-center gap-2.5 px-4 py-10 text-center">
            <span className="pop-in grid size-11 place-items-center rounded-full bg-surface-active text-text-secondary">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                className="size-5"
              >
                <path
                  d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 17 18H7Z"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <p className="text-[14px] font-medium text-foreground">Saved offline</p>
            <p className="text-[12px] text-text-tertiary">Syncs the next time Memry opens.</p>
          </div>
        )}

        {isCard && (
          <div
            className={
              'rise-in flex flex-col gap-3 px-4 py-3.5 ' +
              (editable ? '' : 'pointer-events-none opacity-60')
            }
          >
            {!draft && (
              <div className="flex flex-col items-center gap-1 py-8 text-center">
                <p className="text-[13px] font-medium text-foreground">Couldn't read this page</p>
                <p className="text-[12px] text-text-tertiary">
                  Open a regular web page, then try again.
                </p>
              </div>
            )}

            {draft && (
              <>
                <div className="flex items-center gap-2">
                  <span
                    className="grid size-4 shrink-0 place-items-center rounded bg-surface-active text-[9px] font-bold uppercase leading-none text-text-secondary"
                    aria-hidden
                  >
                    {hostOf(draft.properties.source).charAt(0)}
                  </span>
                  <span className="truncate text-[12px] text-text-tertiary">
                    {hostOf(draft.properties.source)}
                  </span>
                  {draft.mode === 'pdf' && (
                    <span className="rounded bg-surface-active px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                      PDF
                    </span>
                  )}
                </div>

                <EditableTitle
                  value={draft.properties.title}
                  disabled={!editable}
                  onChange={(title) =>
                    setDraft({ ...draft, properties: { ...draft.properties, title } })
                  }
                />

                {draft.extractionStatus === 'failed' && (
                  <p className="text-[12px] text-text-tertiary">
                    Couldn't read the article — saving the link and title.
                  </p>
                )}

                <TagEditor
                  tags={draft.tags ?? []}
                  disabled={!editable}
                  onChange={(tags) => setDraft({ ...draft, tags })}
                />

                {draft.contentMarkdown.trim() && (
                  <details className="group border-t border-border pt-2.5">
                    <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-[12px] font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="size-3 transition-transform duration-[130ms] ease-[var(--ease-out)] group-open:rotate-90"
                        aria-hidden
                      >
                        <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Content
                    </summary>
                    {/* Uncontrolled: untouched keeps the original rich HTML on save; editing
                        replaces it with the user's plain text. Edit-to-save lives in the app. */}
                    <textarea
                      aria-label="Content"
                      key={draft.properties.source}
                      defaultValue={stripHtml(draft.contentMarkdown)}
                      disabled={!editable}
                      onChange={(e) => setDraft({ ...draft, contentMarkdown: e.target.value })}
                      className="mt-1.5 max-h-64 min-h-24 w-full resize-y overflow-y-auto rounded-md border border-border bg-transparent p-2 font-sans text-[13px] leading-relaxed text-text-secondary outline-none focus:border-text-tertiary"
                    />
                  </details>
                )}

                <details className="group border-t border-border pt-2.5">
                  <summary className="flex cursor-pointer select-none list-none items-center gap-1 text-[12px] font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="size-3 transition-transform duration-[130ms] ease-[var(--ease-out)] group-open:rotate-90"
                      aria-hidden
                    >
                      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Details
                  </summary>
                  <div className="pt-1.5">
                    <PropertyRows
                      properties={draft.properties}
                      disabled={!editable}
                      onChange={(properties) => setDraft({ ...draft, properties })}
                    />
                  </div>
                </details>
              </>
            )}
          </div>
        )}
      </main>

      {isCard && (
        <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
          {phase === 'error' && state.errorMessage && (
            <p className="text-[12px] text-text-secondary">{state.errorMessage}</p>
          )}

          {(phase === 'ready' || phase === 'app-closed') && (
            <PrimaryButton
              label="Send to memrynote"
              hint={draft ? SUBMIT_HINT : undefined}
              onClick={onSend}
              disabled={!draft}
            />
          )}
          {phase === 'approving' && <PrimaryButton label="Approve in Memry…" disabled />}
          {phase === 'saving' && <PrimaryButton label="Saving…" disabled />}
          {phase === 'saved' && <PrimaryButton label="Sent ✓" disabled />}
          {phase === 'launching' && <PrimaryButton label="Opening Memry…" disabled />}
          {phase === 'error' && (
            <PrimaryButton label="Try again" onClick={() => dispatch({ type: 'RETRY' })} />
          )}
        </footer>
      )}
    </div>
  )
}
