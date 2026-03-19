/**
 * Editor Error Boundary
 *
 * Error boundary specifically for the BlockNote editor.
 * Provides editor-specific error recovery options and prevents
 * editor crashes from taking down the entire application.
 *
 * @module components/note/editor-error-boundary
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { createLogger } from '@/lib/logger'

const log = createLogger('Component:EditorErrorBoundary')

interface EditorErrorBoundaryProps {
  /** Children to render (the editor) */
  children: ReactNode
  /** Note ID for context */
  noteId?: string
  /** Callback when user triggers recovery */
  onRecover?: () => void
  /** Callback when error occurs (for logging) */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface EditorErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Error boundary for BlockNote editor.
 * Shows a friendly fallback UI when the editor crashes.
 */
export class EditorErrorBoundary extends Component<
  EditorErrorBoundaryProps,
  EditorErrorBoundaryState
> {
  constructor(props: EditorErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): EditorErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    log.error('Editor crash', error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
    this.props.onRecover?.()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          className="h-full flex items-center justify-center p-8 bg-background"
          role="alert"
          aria-live="assertive"
        >
          <div className="flex flex-col items-center gap-4 text-center max-w-md">
            <div
              className="flex items-center justify-center w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30"
              aria-hidden="true"
            >
              <AlertTriangle className="w-8 h-8 text-amber-600 dark:text-amber-400" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">Editor Error</h2>
            <p className="text-sm text-muted-foreground">
              The note editor encountered an error. Your recent changes may not have been saved.
            </p>
            {this.state.error && (
              <details className="w-full">
                <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  Technical details
                </summary>
                <code className="mt-2 block text-xs bg-muted p-2 rounded overflow-auto max-h-24 text-left">
                  {this.state.error.message}
                  {this.state.error.stack && (
                    <>
                      {'\n\n'}
                      {this.state.error.stack}
                    </>
                  )}
                </code>
              </details>
            )}
            <Button
              onClick={this.handleRetry}
              variant="default"
              size="sm"
              className="mt-2"
              aria-label="Reload the editor to try again"
            >
              <RefreshCw className="w-4 h-4 mr-2" aria-hidden="true" />
              Reload Editor
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default EditorErrorBoundary
