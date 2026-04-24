import { useState, useEffect, useCallback } from 'react'
import { createLogger } from '@/lib/logger'
import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'

const log = createLogger('Hook:AIInline')

const AI_GET_SETTINGS_CHANNEL = 'ai-inline:get-settings'
const AI_GET_PORT_CHANNEL = 'ai-inline:get-server-port'
const AI_START_CHANNEL = 'ai-inline:start-server'

export interface AIInlineState {
  port: number | null
  loading: boolean
  error: string | null
  retry: () => void
}

function friendlyError(raw: string, provider: string): string {
  const lower = raw.toLowerCase()
  if (lower.includes('econnrefused') && provider === 'ollama') {
    return 'Ollama is not running. Start it with "ollama serve" and try again.'
  }
  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('401')) {
    return `Invalid API key for ${provider}. Check your key in Settings → AI.`
  }
  if (lower.includes('model') && lower.includes('not found')) {
    return `Model not found. Make sure it's available on your ${provider} instance.`
  }
  return raw
}

export function useAIInline(): AIInlineState {
  const [port, setPort] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => {
    setError(null)
    setPort(null)
    setLoading(true)
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function init(): Promise<void> {
      try {
        const settings = (await window.electron.ipcRenderer.invoke(
          AI_GET_SETTINGS_CHANNEL
        )) as AIInlineSettings

        if (!settings.enabled) {
          if (!cancelled) {
            setPort(null)
            setLoading(false)
          }
          return
        }

        const existingPort = (await window.electron.ipcRenderer.invoke(AI_GET_PORT_CHANNEL)) as
          | number
          | null
        if (existingPort) {
          try {
            const health = await fetch(`http://127.0.0.1:${existingPort}/api/ai/chat`, {
              method: 'OPTIONS'
            })
            if (health.ok && !cancelled) {
              setPort(existingPort)
              setLoading(false)
              log.info('AI server verified on port', existingPort)
              return
            }
          } catch {
            log.warn('Stale port detected, restarting server')
          }
        }

        const result = (await window.electron.ipcRenderer.invoke(AI_START_CHANNEL)) as {
          success: boolean
          port?: number
          error?: string
        }

        if (cancelled) return

        if (result.success && result.port) {
          setPort(result.port)
        } else {
          const msg = friendlyError(result.error ?? 'Failed to start AI server', settings.provider)
          setError(msg)
          log.warn('AI server start failed:', msg)
        }
      } catch (err) {
        if (cancelled) return
        const raw = err instanceof Error ? err.message : 'Unknown error'
        log.error('Failed to initialize AI inline:', raw)
        setError(friendlyError(raw, 'ollama'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void init()
    return () => {
      cancelled = true
    }
  }, [attempt])

  return { port, loading, error, retry }
}
