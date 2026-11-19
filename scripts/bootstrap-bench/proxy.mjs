// A recording reverse proxy between one shell and the sync Worker.
//
// Every shell can point its sync server URL at it, so it counts requests the
// same way for all of them with no production code. Pack downloads are
// presigned R2 URLs on another host: the proxy rewrites the `url` of every
// pack it lists to `/__r2/<url>` and forwards those too, so R2 requests and
// bytes land in the same log. The WebSocket upgrade is passed through.
//
// What it costs: the shell speaks HTTP/1.1 to localhost and the proxy keeps
// its own pooled TLS connections upstream. Both add little next to a 65 ms
// Worker round trip, but a shell that relied on HTTP/2 multiplexing is capped
// at the proxy's sockets instead.

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'

const R2_PREFIX = '/__r2/'
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host'
])

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64 })
}

function forwardHeaders(headers, host) {
  const out = { host }
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_HEADERS.has(name)) out[name] = value
  }
  return out
}

function rewritePackUrls(body, base) {
  const json = JSON.parse(body.toString('utf8'))
  for (const pack of json.packs ?? []) {
    if (typeof pack.url === 'string') {
      pack.url = `${base}${R2_PREFIX}${Buffer.from(pack.url).toString('base64url')}`
    }
  }
  return Buffer.from(JSON.stringify(json))
}

/**
 * Starts the proxy. `requests` fills with one entry per finished request:
 * `{ startMs, endMs, method, path, host: 'worker' | 'r2', status, reqBytes, resBytes }`.
 */
export async function startProxy({ upstream, port = 0 }) {
  const upstreamUrl = new URL(upstream)
  const requests = []

  const server = http.createServer((req, res) => {
    const startMs = Date.now()
    const isR2 = req.url.startsWith(R2_PREFIX)
    const target = isR2
      ? new URL(Buffer.from(req.url.slice(R2_PREFIX.length), 'base64url').toString('utf8'))
      : new URL(req.url, upstreamUrl)
    const isPackList = !isR2 && req.method === 'GET' && target.pathname.endsWith('/packs')
    const headers = forwardHeaders(req.headers, target.host)
    if (isPackList) headers['accept-encoding'] = 'identity'

    const entry = {
      startMs,
      endMs: startMs,
      method: req.method,
      path: target.pathname + target.search,
      host: isR2 ? 'r2' : 'worker',
      status: 0,
      reqBytes: 0,
      resBytes: 0
    }
    req.on('data', (chunk) => (entry.reqBytes += chunk.length))

    const client = target.protocol === 'http:' ? http : https
    const agent = agents[target.protocol]
    const upstreamReq = client.request(target, { method: req.method, headers, agent }, (up) => {
      entry.status = up.statusCode ?? 0
      const outHeaders = forwardHeaders(up.headers, undefined)
      delete outHeaders.host
      const chunks = []
      up.on('data', (chunk) => {
        entry.resBytes += chunk.length
        if (isPackList) chunks.push(chunk)
        else res.write(chunk)
      })
      up.on('end', () => {
        entry.endMs = Date.now()
        requests.push(entry)
        if (isPackList && entry.status === 200) {
          const body = rewritePackUrls(Buffer.concat(chunks), `http://127.0.0.1:${address.port}`)
          delete outHeaders['content-length']
          delete outHeaders['content-encoding']
          res.writeHead(entry.status, { ...outHeaders, 'content-length': body.length })
          res.end(body)
          return
        }
        if (isPackList) {
          res.writeHead(entry.status, outHeaders)
          res.end(Buffer.concat(chunks))
          return
        }
        res.end()
      })
      if (!isPackList) res.writeHead(entry.status, outHeaders)
    })
    upstreamReq.on('error', (error) => {
      entry.endMs = Date.now()
      entry.error = error.message
      requests.push(entry)
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstreamReq)
  })

  server.on('upgrade', (req, socket, head) => {
    const startMs = Date.now()
    const secure = upstreamUrl.protocol === 'https:'
    const upstreamSocket = secure
      ? tls.connect(Number(upstreamUrl.port || 443), upstreamUrl.hostname, {
          servername: upstreamUrl.hostname
        })
      : net.connect(Number(upstreamUrl.port || 80), upstreamUrl.hostname)
    upstreamSocket.on(secure ? 'secureConnect' : 'connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, `host: ${upstreamUrl.host}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() !== 'host') {
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        }
      }
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstreamSocket.write(head)
      socket.pipe(upstreamSocket).pipe(socket)
    })
    const close = () => {
      socket.destroy()
      upstreamSocket.destroy()
    }
    upstreamSocket.on('error', close)
    socket.on('error', close)
    requests.push({
      startMs,
      endMs: startMs,
      method: 'WS',
      path: req.url,
      host: 'worker',
      status: 101,
      reqBytes: 0,
      resBytes: 0
    })
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
        for (const agent of Object.values(agents)) agent.destroy()
      })
  }
}
