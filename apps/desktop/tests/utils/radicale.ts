/**
 * A throwaway Radicale CalDAV server for integration tests. Data lives in a
 * fresh temp directory and is removed on stop; nothing is committed.
 *
 * Radicale is not a repo dependency. Point `RADICALE_BIN` at a `radicale`
 * executable (for example after `python3 -m venv /tmp/radicale-venv &&
 * /tmp/radicale-venv/bin/pip install radicale`), or leave it unset and the
 * suites that need it skip. `/tmp/radicale-venv/bin/radicale` is picked up
 * when present.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const RADICALE_BIN =
  process.env.RADICALE_BIN ??
  (existsSync('/tmp/radicale-venv/bin/radicale') ? '/tmp/radicale-venv/bin/radicale' : null)

export interface RadicaleServer {
  url: string
  username: string
  password: string
  request(path: string, init: RequestInit): Promise<Response>
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('no port'))
      })
    })
  })
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`radicale exited with ${child.exitCode}`)
    try {
      await fetch(url, { method: 'OPTIONS' })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw new Error('radicale did not start')
}

export async function startRadicale(): Promise<RadicaleServer> {
  if (!RADICALE_BIN) throw new Error('RADICALE_BIN is not set')
  const dir = mkdtempSync(join(tmpdir(), 'memry-radicale-'))
  const username = 'memry'
  const password = 'app-password-1'
  writeFileSync(join(dir, 'users'), `${username}:${password}\n`)
  const port = await freePort()
  writeFileSync(
    join(dir, 'config'),
    [
      '[server]',
      `hosts = 127.0.0.1:${port}`,
      '[auth]',
      'type = htpasswd',
      `htpasswd_filename = ${join(dir, 'users')}`,
      'htpasswd_encryption = plain',
      '[storage]',
      `filesystem_folder = ${join(dir, 'collections')}`,
      '[logging]',
      'level = warning',
      ''
    ].join('\n')
  )

  const child = spawn(RADICALE_BIN, ['--config', join(dir, 'config')], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const url = `http://127.0.0.1:${port}/`
  await waitForServer(url, child)

  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  return {
    url,
    username,
    password,
    request: (path, init) =>
      fetch(new URL(path, url), {
        ...init,
        headers: { Authorization: authorization, ...(init.headers as Record<string, string>) }
      }),
    async stop() {
      child.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 100))
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** MKCALENDAR a collection holding events. */
export async function makeCalendar(
  server: RadicaleServer,
  path: string,
  displayName: string
): Promise<void> {
  const response = await server.request(path, {
    method: 'MKCALENDAR',
    headers: { 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop>
    <D:displayname>${displayName}</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
  </D:prop></D:set>
</C:mkcalendar>`
  })
  if (response.status !== 201) throw new Error(`MKCALENDAR failed: ${response.status}`)
}
