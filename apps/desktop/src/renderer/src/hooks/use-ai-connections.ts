import { useState, useEffect, useCallback, useRef } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { AIConnection } from '@/components/journal/ai-connections-panel'
import { getAIConnections, MIN_CONTENT_LENGTH } from '@/services/ai-connections-service'

const AI_ANALYSIS_DEBOUNCE_MS = 2000

export interface UseAIConnectionsResult {
  connections: AIConnection[]
  isLoading: boolean
  error: string | null
  refresh: () => void
}

export function useAIConnections(content: string): UseAIConnectionsResult {
  const [connections, setConnections] = useState<AIConnection[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAnalyzedContentRef = useRef<string | null>(null)

  const contentRef = useRef(content)
  contentRef.current = content

  const analyzeContent = useCallback(async (contentToAnalyze: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    if (contentToAnalyze.length < MIN_CONTENT_LENGTH) {
      setConnections([])
      setIsLoading(false)
      setError(null)
      lastAnalyzedContentRef.current = null
      return
    }

    if (contentToAnalyze === lastAnalyzedContentRef.current) return

    const abortController = new AbortController()
    abortControllerRef.current = abortController

    setIsLoading(true)
    setError(null)

    try {
      const result = await getAIConnections(contentToAnalyze, abortController.signal)

      if (!abortController.signal.aborted) {
        setConnections(result)
        setIsLoading(false)
        lastAnalyzedContentRef.current = contentToAnalyze
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return

      if (!abortController.signal.aborted) {
        setError(extractErrorMessage(err, 'Failed to analyze content'))
        setIsLoading(false)
      }
    }
  }, [])

  // Interval-based polling to detect content changes without effect re-runs
  useEffect(() => {
    let lastCheckedContent = contentRef.current
    let pendingAnalysisTimeout: ReturnType<typeof setTimeout> | null = null

    const checkInterval = setInterval(() => {
      const currentContent = contentRef.current

      if (currentContent === lastCheckedContent) return

      lastCheckedContent = currentContent

      if (pendingAnalysisTimeout) {
        clearTimeout(pendingAnalysisTimeout)
      }

      if (currentContent.length < MIN_CONTENT_LENGTH) {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort()
          abortControllerRef.current = null
        }
        setConnections([])
        setIsLoading(false)
        setError(null)
        lastAnalyzedContentRef.current = null
        return
      }

      pendingAnalysisTimeout = setTimeout(() => {
        if (currentContent !== lastAnalyzedContentRef.current) {
          analyzeContent(currentContent)
        }
      }, AI_ANALYSIS_DEBOUNCE_MS)
    }, 500)

    if (contentRef.current.length >= MIN_CONTENT_LENGTH) {
      pendingAnalysisTimeout = setTimeout(() => {
        analyzeContent(contentRef.current)
      }, AI_ANALYSIS_DEBOUNCE_MS)
    }

    return () => {
      clearInterval(checkInterval)
      if (pendingAnalysisTimeout) {
        clearTimeout(pendingAnalysisTimeout)
      }
    }
  }, [analyzeContent])

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

  const refresh = useCallback(() => {
    lastAnalyzedContentRef.current = null

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }

    analyzeContent(contentRef.current)
  }, [analyzeContent])

  return {
    connections,
    isLoading,
    error,
    refresh
  }
}
