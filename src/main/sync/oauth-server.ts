/**
 * OAuth Loopback Server
 *
 * Creates a temporary HTTP server to receive OAuth callbacks from the browser.
 * Used for Google OAuth compatibility which requires http:// redirect URIs.
 *
 * @module oauth-server
 */

import http from 'node:http'
import { URL } from 'node:url'

interface OAuthCallbackParams {
  code: string
  state: string
}

interface OAuthServer {
  port: number
  waitForCallback: () => Promise<OAuthCallbackParams>
  close: () => void
}

const CALLBACK_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes

/**
 * HTML page shown to user after successful OAuth callback
 */
const successHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      background: white;
      padding: 48px;
      border-radius: 16px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      max-width: 400px;
    }
    .checkmark {
      width: 64px;
      height: 64px;
      background: #10b981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .checkmark svg {
      width: 32px;
      height: 32px;
      color: white;
    }
    h1 {
      color: #1f2937;
      margin: 0 0 12px;
      font-size: 24px;
    }
    p {
      color: #6b7280;
      margin: 0;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/>
      </svg>
    </div>
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Memry.</p>
  </div>
</body>
</html>`

/**
 * HTML page shown to user if OAuth callback is missing required params
 */
const errorHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
    }
    .container {
      background: white;
      padding: 48px;
      border-radius: 16px;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
      max-width: 400px;
    }
    .error-icon {
      width: 64px;
      height: 64px;
      background: #ef4444;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .error-icon svg {
      width: 32px;
      height: 32px;
      color: white;
    }
    h1 {
      color: #1f2937;
      margin: 0 0 12px;
      font-size: 24px;
    }
    p {
      color: #6b7280;
      margin: 0;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </div>
    <h1>Authorization Failed</h1>
    <p>Something went wrong. Please try again in Memry.</p>
  </div>
</body>
</html>`

/**
 * Start a temporary HTTP server to receive OAuth callbacks.
 *
 * The server listens on a random available port and waits for a GET request
 * to /oauth/callback with code and state query parameters.
 *
 * @returns Promise resolving to server info and callback waiter
 */
export function startOAuthServer(): Promise<OAuthServer> {
  return new Promise((resolve, reject) => {
    let callbackResolve: ((params: OAuthCallbackParams) => void) | null = null
    let callbackReject: ((error: Error) => void) | null = null
    let timeoutId: NodeJS.Timeout | null = null

    const server = http.createServer((req, res) => {
      // Only handle GET requests to /oauth/callback
      if (req.method !== 'GET' || !req.url?.startsWith('/oauth/callback')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }

      // Parse query params
      const url = new URL(req.url, `http://127.0.0.1`)
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')

      // Handle OAuth error response
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(errorHtml)
        callbackReject?.(new Error(`OAuth error: ${error}`))
        cleanup()
        return
      }

      // Validate required params
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(errorHtml)
        callbackReject?.(new Error('Missing code or state in OAuth callback'))
        cleanup()
        return
      }

      // Send success response to browser
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(successHtml)

      // Resolve with callback params
      callbackResolve?.({ code, state })
      cleanup()
    })

    const cleanup = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      server.close()
    }

    // Listen on a random available port
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to get server address'))
        return
      }

      const port = address.port

      resolve({
        port,
        waitForCallback: () => {
          return new Promise<OAuthCallbackParams>((res, rej) => {
            callbackResolve = res
            callbackReject = rej

            // Set timeout for callback
            timeoutId = setTimeout(() => {
              rej(new Error('OAuth callback timed out'))
              cleanup()
            }, CALLBACK_TIMEOUT_MS)
          })
        },
        close: cleanup
      })
    })

    server.on('error', (err) => {
      reject(err)
    })
  })
}

/**
 * Get the OAuth callback URL based on environment configuration.
 *
 * If OAUTH_CALLBACK_URL starts with http://127.0.0.1 or http://localhost,
 * appends the port and callback path. Otherwise, uses the URL as-is.
 *
 * @param port - Port number for loopback server (required for loopback URLs)
 * @returns Full callback URL
 */
export function getOAuthCallbackUrl(port?: number): string {
  const baseUrl = process.env.OAUTH_CALLBACK_URL || 'http://127.0.0.1'

  // Check if it's a loopback URL
  if (baseUrl.startsWith('http://127.0.0.1') || baseUrl.startsWith('http://localhost')) {
    if (port === undefined) {
      throw new Error('Port is required for loopback OAuth callback URL')
    }
    return `http://127.0.0.1:${port}/oauth/callback`
  }

  // For production URLs, append the callback path if not present
  if (!baseUrl.includes('/oauth/callback')) {
    return `${baseUrl}/oauth/callback`
  }

  return baseUrl
}

/**
 * Check if the current configuration uses loopback OAuth.
 *
 * @returns true if using loopback server, false if using web-based callback
 */
export function isLoopbackOAuth(): boolean {
  const baseUrl = process.env.OAUTH_CALLBACK_URL || 'http://127.0.0.1'
  return baseUrl.startsWith('http://127.0.0.1') || baseUrl.startsWith('http://localhost')
}
