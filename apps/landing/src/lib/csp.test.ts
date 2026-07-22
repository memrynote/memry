import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

// connect-src must list every external host the browser talks to.
const REQUIRED_CONNECT_SRC = ['https://sync.memrynote.com', 'https://e.memrynote.com']

function getConnectSrc(): string {
  const vercelPath = fileURLToPath(new URL('../../vercel.json', import.meta.url))
  const config = JSON.parse(readFileSync(vercelPath, 'utf8'))
  const csp = config.headers
    .flatMap((entry: { headers: { key: string; value: string }[] }) => entry.headers)
    .find((header: { key: string }) => header.key === 'Content-Security-Policy')?.value as string
  return csp.split(';').find((directive) => directive.trim().startsWith('connect-src')) ?? ''
}

describe('landing CSP', () => {
  it('allows every host the browser connects to', () => {
    const connectSrc = getConnectSrc()
    for (const host of REQUIRED_CONNECT_SRC) {
      assert.ok(connectSrc.includes(host), `connect-src is missing ${host}`)
    }
  })
})
