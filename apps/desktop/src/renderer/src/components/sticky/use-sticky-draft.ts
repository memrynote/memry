import { useCallback, useEffect, useRef, useState } from 'react'
import type { StickyDraft, StickyKind } from '@memry/contracts/sticky-api'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:StickyDraft')

/** Typing pauses this long before the draft is written. */
const SAVE_DELAY_MS = 400

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed'

export interface StickyDraftState {
  ready: boolean
  content: string
  kind: StickyKind
  draftId: string | null
  saveStatus: SaveStatus
  setContent: (content: string) => void
  setKind: (kind: StickyKind) => void
  /** Write pending text now; resolves with the draft id once main has it. */
  flush: () => Promise<string | null>
  /** Remove the draft and clear the sticky; returns what was removed for Undo. */
  discard: () => Promise<{ content: string; kind: StickyKind } | null>
  /** Put deleted text back (Undo of a delete) as a fresh draft. */
  restore: (content: string, kind: StickyKind) => void
  /** Show a draft main already wrote (Undo of a send brings it back). */
  adopt: (draft: StickyDraft) => void
  /** Forget the draft locally after main deleted it (a send). */
  clear: () => void
}

/**
 * The sticky's text, kept as a synced draft: it opens on the draft main chose
 * for this window, writes every pause in typing, and deletes the draft when
 * the text is emptied, so an empty sticky leaves nothing behind.
 */
export function useStickyDraft(): StickyDraftState {
  const [ready, setReady] = useState(false)
  const [content, setContentState] = useState('')
  const [kind, setKindState] = useState<StickyKind>('note')
  const [draftId, setDraftId] = useState<string | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')

  const latest = useRef({ content: '', kind: 'note' as StickyKind, draftId: null as string | null })
  const timer = useRef<number | null>(null)
  const writing = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [session, drafts, settings] = await Promise.all([
          window.api.sticky.getSession(),
          window.api.sticky.listDrafts(),
          window.api.settings.getStickySettings()
        ])
        if (cancelled) return
        const draft = session.draftId ? drafts.find((d) => d.id === session.draftId) : undefined
        const startKind = settings.defaultKind === 'last' ? settings.lastKind : settings.defaultKind
        latest.current = {
          content: draft?.content ?? '',
          kind: draft?.kind ?? startKind,
          draftId: draft?.id ?? null
        }
        setContentState(latest.current.content)
        setKindState(latest.current.kind)
        setDraftId(latest.current.draftId)
      } catch (err) {
        log.error('Failed to load the sticky draft', err)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /** One write at a time, in order, so an id from a create reaches the next save. */
  const write = useCallback((): Promise<void> => {
    const run = writing.current.then(async () => {
      const { content: text, kind: k, draftId: id } = latest.current
      try {
        if (!text.trim()) {
          if (id) {
            await window.api.sticky.deleteDraft(id)
            latest.current.draftId = null
            setDraftId(null)
          }
          setSaveStatus('idle')
          return undefined
        }
        setSaveStatus('saving')
        const saved = await window.api.sticky.saveDraft({
          id: id ?? undefined,
          content: text,
          kind: k
        })
        latest.current.draftId = saved.id
        setDraftId(saved.id)
        setSaveStatus('saved')
      } catch (err) {
        log.error('Failed to save the sticky draft', err)
        setSaveStatus('failed')
      }
      return undefined
    })
    writing.current = run
    return run
  }, [])

  const schedule = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      void write()
    }, SAVE_DELAY_MS)
  }, [write])

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
      await write()
    } else {
      await writing.current
    }
    return latest.current.draftId
  }, [write])

  useEffect(
    () => () => {
      if (timer.current !== null) void write()
    },
    [write]
  )

  const setContent = useCallback(
    (next: string) => {
      latest.current.content = next
      setContentState(next)
      schedule()
    },
    [schedule]
  )

  const setKind = useCallback(
    (next: StickyKind) => {
      latest.current.kind = next
      setKindState(next)
      if (latest.current.content.trim()) schedule()
    },
    [schedule]
  )

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    latest.current = { ...latest.current, content: '', draftId: null }
    setContentState('')
    setDraftId(null)
    setSaveStatus('idle')
  }, [])

  const discard = useCallback(async () => {
    await flush()
    const { content: text, kind: k, draftId: id } = latest.current
    if (!text.trim()) return null
    clear()
    if (id) await window.api.sticky.deleteDraft(id)
    return { content: text, kind: k }
  }, [flush, clear])

  const restore = useCallback(
    (text: string, k: StickyKind) => {
      latest.current = { content: text, kind: k, draftId: null }
      setContentState(text)
      setKindState(k)
      setDraftId(null)
      void write()
    },
    [write]
  )

  const adopt = useCallback((draft: StickyDraft) => {
    latest.current = { content: draft.content, kind: draft.kind, draftId: draft.id }
    setContentState(draft.content)
    setKindState(draft.kind)
    setDraftId(draft.id)
    setSaveStatus('saved')
  }, [])

  return {
    ready,
    content,
    kind,
    draftId,
    saveStatus,
    setContent,
    setKind,
    flush,
    discard,
    restore,
    adopt,
    clear
  }
}
