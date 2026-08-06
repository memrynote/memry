import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { redactLogLine } from './redact'
import { buildErrorDetail } from './telemetry-api'

// Real salted hasher (this test runs under Node/Vitest, node:crypto available).
const hash = (v: string): string =>
  createHash('sha256')
    .update('SALT' + v)
    .digest('hex')
    .slice(0, 16)
const opts = { vaultRoot: '/home/victim/Vault', hash }

// Synthetic secrets that must NEVER survive verbatim in the output.
const SECRETS = [
  'kaan94karaca@gmail.com',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'sk-live-fake987654',
  '/Users/kaan/Vault/Very Secret Note.md',
  '/home/victim/Vault/Attachments/Passport Scan.pdf',
  '203.0.113.42',
  '1f2e3d4c-5b6a-7980-1122-334455667788'
]

const serialize = (o: unknown): string => JSON.stringify(o)

describe('fuzz invariant — no raw secret survives', () => {
  for (const secret of SECRETS) {
    it(`drops "${secret.slice(0, 20)}…" from message`, () => {
      const out = redactLogLine({ message: `context ${secret} more` }, opts)
      expect(serialize(out)).not.toContain(secret)
    })
    it(`drops "${secret.slice(0, 20)}…" from an unknown field`, () => {
      const out = redactLogLine(
        { message: 'x', fields: { detail: secret, wrapped: { nested: secret } } },
        opts
      )
      expect(serialize(out)).not.toContain(secret)
    })
    it(`drops "${secret.slice(0, 20)}…" smuggled under a verbatim field key`, () => {
      const out = redactLogLine({ message: 'x', fields: { reason: secret } }, opts)
      expect(serialize(out)).not.toContain(secret)
    })
  }

  it('combined payload leaks nothing', () => {
    const out = redactLogLine(
      {
        message: SECRETS.join(' | '),
        fields: Object.fromEntries(SECRETS.map((s, i) => [`k${i}`, s]))
      },
      opts
    )
    const dump = serialize(out)
    for (const s of SECRETS) expect(dump).not.toContain(s)
  })
})

// TelemetryErrorDetail.message is the ONE telemetry field carrying free-form
// error text, so the same invariant has to hold there — and it is redacted by a
// different call path (buildErrorDetail → redactText) than the log lines above.
describe('fuzz invariant — no raw secret survives buildErrorDetail.message', () => {
  for (const secret of SECRETS) {
    it(`drops "${secret.slice(0, 20)}…" with the salted (main-process) config`, () => {
      const detail = buildErrorDetail(new Error(`operation failed: ${secret}`), undefined, opts)
      expect(detail?.message).toBeTruthy()
      expect(serialize(detail)).not.toContain(secret)
    })
    it(`drops "${secret.slice(0, 20)}…" in mask mode (renderer, no salt)`, () => {
      const detail = buildErrorDetail(new Error(`operation failed: ${secret}`))
      expect(detail?.message).toBeTruthy()
      expect(serialize(detail)).not.toContain(secret)
    })
  }

  it('combined payload leaks nothing, from message or component stack', () => {
    const detail = buildErrorDetail(
      new Error(SECRETS.join(' | ')),
      `    in Editor (at ${SECRETS[3]})`,
      opts
    )
    const dump = serialize(detail)
    for (const s of SECRETS) expect(dump).not.toContain(s)
  })

  it('keeps the message useful — the diagnostic prose survives redaction', () => {
    const detail = buildErrorDetail(
      new Error('Failed to open vault: EACCES /home/victim/Vault/Notes/Passport Scan.pdf'),
      undefined,
      opts
    )
    expect(detail?.message).toContain('Failed to open vault: EACCES')
    expect(detail?.message).toContain('<vault>/Notes/')
    expect(detail?.message).not.toContain('Passport Scan')
  })
})

describe('the three known failure-mode lines are clean AND useful', () => {
  it('memry-file blocked path', () => {
    const out = redactLogLine(
      {
        message: 'memry-file: blocked path outside allowed directories',
        fields: { filePath: '/home/victim/Vault/Attachments/Passport Scan.pdf' }
      },
      opts
    )
    expect(out.message).toBe('memry-file: blocked path outside allowed directories') // static, useful
    expect(serialize(out)).not.toContain('Passport Scan')
    expect(String(out.fields.filePath)).toContain('<vault>/Attachments/') // still shows shape
  })
  it('unresolvable signer', () => {
    const out = redactLogLine(
      {
        message: 'Skipping CRDT update from unresolvable signer',
        fields: {
          noteId: '1f2e3d4c-5b6a-7980-1122-334455667788',
          signerDeviceId: 'device-abc',
          sequenceNum: 42
        }
      },
      opts
    )
    expect(out.fields.sequenceNum).toBe(42)
    expect(out.fields.noteId).not.toContain('1f2e3d4c')
    expect(out.fields.signerDeviceId).not.toBe('device-abc')
  })
  it('invalid pull response', () => {
    const out = redactLogLine(
      {
        message: 'Invalid pull response from server',
        fields: { error: 'expected string at path items.0.id' }
      },
      opts
    )
    expect(out.message).toBe('Invalid pull response from server')
  })
})
