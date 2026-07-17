import { describe, expect, it } from 'vitest'
import { redactText, type RedactOptions } from './redact'

const hash = (v: string): string =>
  // deterministic non-crypto stand-in for tests; real desktop uses salted sha256
  'h' +
  Array.from(v)
    .reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381)
    .toString(16)
    .slice(0, 7)
const withHash: RedactOptions = { hash }

describe('redactText — secrets are dropped, never hashed', () => {
  it('drops a JWT', () => {
    const out = redactText(
      'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456',
      withHash
    )
    expect(out).not.toContain('eyJhbGci')
    expect(out).toContain('<redacted>')
  })
  it('drops an Authorization bearer value', () => {
    expect(redactText('Authorization: Bearer sk-FAKEkey12345')).not.toContain('sk-FAKEkey')
  })
  it('drops a plain bearer token after an Authorization header', () => {
    expect(redactText('Authorization: Bearer randomToken123abc')).not.toContain('randomToken123abc')
  })
  it('drops an sk- API key', () => {
    expect(redactText('using key sk-live-fake9876')).not.toContain('fake9876')
  })
  it('drops a client_secret value rather than hashing it', () => {
    const out = redactText('client_secret=1f2e3d4c-5b6a-7980-1122-334455667788', withHash)
    expect(out).toContain('<redacted>')
    expect(out).not.toContain('1f2e3d4c')
  })
  it('does not over-redact a non-secret key ending', () => {
    expect(redactText('sortKey=name cacheKey=abc tokenCount=5')).toContain('sortKey=name')
  })
  it('strips a URL query string but keeps host+path', () => {
    const out = redactText('GET https://sync.memrynote.com/sync/changes?token=secretvalue&cursor=9')
    expect(out).toContain('https://sync.memrynote.com/sync/changes')
    expect(out).not.toContain('secretvalue')
  })
})

describe('redactText — paths collapse, content basenames hash', () => {
  it('collapses a macOS home path', () => {
    expect(redactText('/Users/kaan/Documents/x')).toContain('~/Documents/x')
    expect(redactText('/Users/kaan/Documents/x')).not.toContain('kaan')
  })
  it('collapses a linux home + /root', () => {
    expect(redactText('/home/fedorauser/Vault')).not.toContain('fedorauser')
    expect(redactText('/root/secret')).toContain('~')
  })
  it('collapses the vault root when provided', () => {
    const out = redactText('/home/u/MyVault/Attachments/report.pdf', {
      vaultRoot: '/home/u/MyVault',
      ...withHash
    })
    expect(out).toContain('<vault>/Attachments/')
    expect(out).not.toContain('report')
  })
  it('hashes a content-file basename but keeps the extension', () => {
    const out = redactText('opened Secret Meeting Notes.md', withHash)
    expect(out).not.toContain('Secret Meeting Notes')
    expect(out).toMatch(/\[name:h[0-9a-f]+\]\.md/)
  })
  it('masks a content basename without a hasher (server mask-mode)', () => {
    expect(redactText('opened Secret Meeting Notes.md')).toMatch(/\[name\]\.md/)
  })
  it('keeps code file names in stack frames (not content extensions)', () => {
    const frame = '    at foo (/app/src/main/index.ts:1036:7)'
    expect(redactText(frame)).toContain('index.ts:1036:7')
  })
})

describe('redactText — emails, ids, ips', () => {
  it('hashes an email with a hasher', () => {
    const out = redactText('from kaan94karaca@gmail.com', withHash)
    expect(out).not.toContain('kaan94karaca')
    expect(out).toMatch(/\[email:h[0-9a-f]+\]/)
  })
  it('masks an email without a hasher', () => {
    expect(redactText('from kaan94karaca@gmail.com')).toContain('<email>')
  })
  it('hashes a UUID-shaped id with a hasher', () => {
    const out = redactText('noteId=1f2e3d4c-5b6a-7980-1122-334455667788', withHash)
    expect(out).not.toContain('1f2e3d4c-5b6a')
  })
  it('masks a UUID without a hasher', () => {
    expect(redactText('noteId=1f2e3d4c-5b6a-7980-1122-334455667788')).toContain('<id>')
  })
  it('masks an IPv4', () => {
    expect(redactText('peer 203.0.113.42 connected')).toContain('<ip>')
  })
  it('does not leak an email local-part before a content extension', () => {
    expect(redactText('exported kaan94karaca@gmail.com.pdf')).not.toContain('kaan94karaca')
  })
  it('keeps a space-separated log timestamp', () => {
    expect(redactText('2026-07-18 14:23:07 INFO up')).toContain('14:23:07')
  })
  it('masks a compressed IPv6', () => {
    expect(redactText('peer fe80::1a2b:3c4d connected')).toContain('<ip>')
  })
})
