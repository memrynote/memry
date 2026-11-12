import { useCallback, useEffect, useRef, useState } from 'react'
import { getI18n } from 'react-i18next'
import type { InitOAuthResult, SetupFirstDeviceResult } from '@memry/contracts/ipc-auth'
import type { OAuthCallbackEvent } from '@memry/contracts/ipc-events'
import { authService } from '@/services/auth-service'
import { extractErrorMessage } from '@/lib/ipc-error'

type OAuthFlow =
  | { kind: 'idle' }
  | { kind: 'starting'; callback: OAuthCallbackEvent | null }
  | { kind: 'waiting'; session: InitOAuthResult }
  | { kind: 'exchanging' }

interface OAuthSignInOptions {
  onStart: () => void
  onVerified: (result: SetupFirstDeviceResult) => void
  onError: (message: string) => void
  onCancel: () => void
}

export function useOAuthSignIn({ onStart, onVerified, onError, onCancel }: OAuthSignInOptions) {
  const [flow, setFlowState] = useState<OAuthFlow>({ kind: 'idle' })
  const flowRef = useRef(flow)
  const setFlow = useCallback((next: OAuthFlow) => {
    flowRef.current = next
    setFlowState(next)
  }, [])

  const fail = useCallback(
    (cause: unknown) => {
      setFlow({ kind: 'idle' })
      onError(
        extractErrorMessage(
          cause,
          getI18n().getFixedT(null, 'settings')('setup.signIn.errors.googleStart')
        )
      )
    },
    [onError, setFlow]
  )

  const complete = useCallback(
    async (event: OAuthCallbackEvent): Promise<void> => {
      const current = flowRef.current
      if (current.kind === 'starting') {
        // The browser can return before the launch IPC response reaches this window.
        current.callback = event
        return
      }
      if (current.kind !== 'waiting' || event.state !== current.session.state) return
      const exchanging: OAuthFlow = { kind: 'exchanging' }
      setFlow(exchanging)
      try {
        const result = await authService.setupFirstDevice({
          provider: 'google',
          oauthToken: event.code,
          state: event.state
        })
        if (flowRef.current !== exchanging) return
        if (result.error) {
          fail(result.error)
          return
        }
        setFlow({ kind: 'idle' })
        onVerified(result)
      } catch (error: unknown) {
        if (flowRef.current === exchanging) fail(error)
      }
    },
    [fail, onVerified, setFlow]
  )

  useEffect(() => {
    const unsubscribeCallback = window.api.onOAuthCallback((event) => {
      void complete(event)
    })
    const unsubscribeError = window.api.onOAuthError(({ error }) => {
      if (flowRef.current.kind !== 'idle') fail(error)
    })
    return () => {
      flowRef.current = { kind: 'idle' }
      unsubscribeCallback()
      unsubscribeError()
    }
  }, [complete, fail])

  const initOAuth = useCallback(async (): Promise<InitOAuthResult | null> => {
    const starting: Extract<OAuthFlow, { kind: 'starting' }> = { kind: 'starting', callback: null }
    setFlow(starting)
    onStart()
    try {
      const result = await authService.initOAuth({ provider: 'google' })
      if (flowRef.current !== starting) return null
      if ('error' in result) {
        fail(result.error)
        return null
      }
      setFlow({ kind: 'waiting', session: result })
      if (starting.callback) void complete(starting.callback)
      return result
    } catch (error: unknown) {
      if (flowRef.current === starting) fail(error)
      return null
    }
  }, [complete, fail, onStart, setFlow])

  const retryOAuth = useCallback(async (): Promise<void> => {
    const current = flowRef.current
    if (current.kind !== 'waiting') return
    try {
      const result = await authService.retryOAuth({ state: current.session.state })
      if (flowRef.current !== current) return
      if ('error' in result) {
        fail(result.error)
        return
      }
      setFlow({
        kind: 'waiting',
        session: { ...current.session, browserOpened: result.browserOpened }
      })
    } catch (error: unknown) {
      if (flowRef.current === current) fail(error)
    }
  }, [fail, setFlow])

  const cancelOAuth = useCallback(() => {
    if (flowRef.current.kind === 'idle') return
    setFlow({ kind: 'idle' })
    onCancel()
  }, [onCancel, setFlow])

  return {
    oauthSession: flow.kind === 'waiting' ? flow.session : null,
    isOAuthBusy: flow.kind === 'starting' || flow.kind === 'exchanging',
    initOAuth,
    retryOAuth,
    cancelOAuth
  }
}
