import http from 'node:http'
import { app } from 'electron'
import { ArticleCaptureSchema } from '@memry/contracts/capture-api'
import { ingestArticleCapture } from '../inbox/ingest'
import {
  getCaptureToken,
  isOriginAllowed,
  claimPairing,
  openPairingWindow,
  unpairCapture
} from './pairing'
import { validateCaptureRequest, isExtensionOrigin } from './auth'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { trackMainEvent } from '../telemetry/track'

const log = createLogger('Capture:Server')

const DEFAULT_PORT = 7849
const PROBE_RANGE = 8 // try 7849..7856

let server: http.Server | null = null
let currentPort: number | null = null
let startInFlight: Promise<number> | null = null
let requestPairConsent: ((origin: string) => Promise<boolean>) | null = null
const pendingConsent = new Set<string>()

export function getCaptureServerPort(): number | null {
  return server?.listening ? currentPort : null
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 25 * 1024 * 1024) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
  res.end(JSON.stringify(body))
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const origin = req.headers.origin

  if (req.method === 'GET' && req.url === '/ping') {
    json(res, 200, { app: 'memry', version: app.getVersion(), paired: isOriginAllowed(origin) })
    return
  }

  if (req.method === 'POST' && req.url === '/pair/claim') {
    if (!origin) {
      json(res, 400, { error: 'missing-origin' })
      return
    }
    const claim = await claimPairing(origin)
    if (!claim) {
      json(res, 403, { error: 'pairing-window-closed' })
      return
    }
    json(res, 200, { token: claim.token, port: currentPort })
    return
  }

  if (req.method === 'POST' && req.url === '/pair/request') {
    if (!origin) {
      json(res, 400, { error: 'missing-origin' })
      return
    }
    if (!isExtensionOrigin(origin)) {
      json(res, 403, { error: 'origin-not-allowed' })
      return
    }
    if (req.headers['x-memry-capture'] !== '1') {
      json(res, 401, { error: 'missing-capture-header' })
      return
    }
    if (isOriginAllowed(origin)) {
      openPairingWindow()
      json(res, 200, { status: 'already-paired' })
      return
    }
    if (requestPairConsent && !pendingConsent.has(origin)) {
      pendingConsent.add(origin)
      void requestPairConsent(origin)
        .then((allowed) => {
          if (allowed) openPairingWindow()
        })
        .finally(() => pendingConsent.delete(origin))
    }
    json(res, 202, { status: 'pending' })
    return
  }

  if (req.method === 'POST' && req.url === '/capture') {
    const token = await getCaptureToken()
    const auth = validateCaptureRequest(
      {
        authorization: req.headers.authorization,
        origin,
        'x-memry-capture': req.headers['x-memry-capture'] as string | undefined
      },
      token,
      isOriginAllowed
    )
    if (!auth.ok) {
      req.resume() // drain body so the client receives the response cleanly
      json(res, 401, { error: auth.reason })
      return
    }
    let body: string
    try {
      body = await readBody(req)
    } catch {
      json(res, 413, { error: 'payload-too-large' })
      return
    }
    let parsed: ReturnType<typeof ArticleCaptureSchema.safeParse>
    try {
      parsed = ArticleCaptureSchema.safeParse(JSON.parse(body))
    } catch {
      json(res, 422, { error: 'invalid-capture' })
      return
    }
    if (!parsed.success) {
      json(res, 422, { error: 'invalid-capture' })
      return
    }
    const result = await ingestArticleCapture(parsed.data, 'browser-extension')
    // The extension bypasses the inbox IPC handlers (where inbox_captured is
    // normally emitted), so clipper intake must be tracked here.
    trackMainEvent('inbox_captured', {
      surface: 'inbox',
      action: 'captured',
      objectType: 'inbox_clipper',
      source: 'browser_extension',
      result: 'success',
      dimensions: { capture_type: 'clipper' }
    })
    json(res, 200, { itemId: result.itemId })
    return
  }

  if (req.method === 'POST' && req.url === '/pair/revoke') {
    const token = await getCaptureToken()
    const auth = validateCaptureRequest(
      {
        authorization: req.headers.authorization,
        origin,
        'x-memry-capture': req.headers['x-memry-capture'] as string | undefined
      },
      token,
      isOriginAllowed
    )
    if (!auth.ok) {
      json(res, 401, { error: auth.reason })
      return
    }
    await unpairCapture()
    json(res, 200, { ok: true })
    return
  }

  json(res, 404, { error: 'not-found' })
}

function listen(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const next = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        log.error('capture request failed', err)
        trackMainError('capture_server', 'capture_request', err)
        if (!res.headersSent) json(res, 500, { error: 'internal' })
      })
    })
    next.once('error', reject)
    next.listen(port, '127.0.0.1', () => {
      server = next
      currentPort = port
      next.removeListener('error', reject)
      // Keep a lifetime error handler: without one, any later server 'error'
      // event is unhandled and crashes the process.
      next.on('error', (err) => log.error('capture server error', err))
      log.info(`capture server on 127.0.0.1:${port}`)
      resolve(port)
    })
  })
}

export async function startCaptureServer(
  deps: { requestPairConsent?: (origin: string) => Promise<boolean> } = {}
): Promise<number> {
  requestPairConsent = deps.requestPairConsent ?? null
  pendingConsent.clear() // reset stale per-origin consent guards across restarts
  if (server?.listening && currentPort !== null) return currentPort
  // Collapse concurrent starts: without this, two callers both pass the
  // listening check and bind two servers, orphaning the first.
  if (startInFlight) return startInFlight
  startInFlight = (async () => {
    for (let i = 0; i < PROBE_RANGE; i++) {
      try {
        return await listen(DEFAULT_PORT + i)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE') throw err
      }
    }
    throw new Error('no free capture port in probe range')
  })()
  try {
    return await startInFlight
  } catch (err) {
    // A failed start kills the whole clipper feature for the session; the
    // caller only logs, so report it here.
    trackMainError('capture_server', 'capture_server_start', err)
    throw err
  } finally {
    startInFlight = null
  }
}

export async function stopCaptureServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve()
    const closing = server
    server = null
    currentPort = null
    if (!closing.listening) return resolve()
    // Destroy open keep-alive connections so the port is immediately reclaimable
    closing.closeAllConnections?.()
    closing.close(() => resolve())
  })
}
