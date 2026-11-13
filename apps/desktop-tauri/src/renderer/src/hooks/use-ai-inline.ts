import { useState, useEffect, useCallback } from 'react'
import { commands, events } from '../../../generated/bindings'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('Hook:AIInline')

export interface AIInlineState {
  /** Inline AI is on: the editor registers the AI extension. */
  ready: boolean
  loading: boolean
  error: string | null
  retry: () => void
}

/**
 * Whether inline AI is on, from its settings. Requests go through `ai_provider_request` when the
 * AI menu runs, so nothing starts here; a missing key or an unreachable provider shows in the
 * menu. `AiInlineSettingsChangedEvent` keeps the state current.
 */
export function useAIInline(aiEnabled = true): AIInlineState {
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setError(null)
    setLoading(true)
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!aiEnabled) return undefined
    let active = true
    let heard = false
    const registered = events.aiInlineSettingsChangedEvent.listen(({ payload }) => {
      if (!active) return
      heard = true
      setEnabled(payload.settings.enabled)
      setError(null)
    })
    // The read waits for the listener, so a change between the two is not lost; a read answered
    // after a broadcast is older than it and dropped.
    void registered
      .catch((err: unknown) => log.warn('AI inline settings subscription failed', err))
      .then(() => commands.aiInlineGetSettings())
      .then((settings) => {
        if (active && !heard) setEnabled(settings.enabled)
      })
      .catch((err: unknown) => {
        if (!active) return
        log.error('Failed to read the inline AI settings', err)
        setError(extractErrorMessage(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      // A subscription that failed was logged when it failed; there is nothing to undo.
      void registered
        .then(
          (unlisten) => unlisten(),
          () => undefined
        )
        .catch((err: unknown) => log.warn('Unsubscribing from the inline AI settings failed', err))
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- attempt is the retry trigger, not read inside the effect
  }, [attempt, aiEnabled])

  if (!aiEnabled) return { ready: false, loading: false, error: null, retry }
  return { ready: enabled && error === null, loading, error, retry }
}
