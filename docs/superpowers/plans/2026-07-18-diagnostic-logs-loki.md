# Redacted Diagnostic Logs → Loki + Opt-in Incident Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. When touching IPC (Phase 5), also use the `ipc-contract-change` skill.

**Goal:** See why a user hit an error from Grafana alone — ship redacted desktop log lines to Loki always-on (Path A), and let users send a one-time redacted incident report on demand (Path B) — without ever leaking note content, paths, emails, tokens, or keys.

**Architecture:** A crypto-free redaction module in `packages/contracts` is the single source of truth, imported by desktop main (salted hasher injected) and the sync-server (mask-mode, defense-in-depth). Path A is a redacting `electron-log` transport installed in the main process that catches every `log.warn`/`log.error` record (main + worker-forwarded), redacts, batches, and POSTs to `/telemetry/logs`. Path B assembles a redacted bundle from a ring buffer fed by the same transport and POSTs to `/diagnostics/report` on explicit consent with a preview. The sync-server maps both to Loki entries with a new low-cardinality `kind` label. Server ships and deploys before any desktop build that sends to it.

**Tech Stack:** TypeScript, Electron (`electron-log`, `utilityProcess`), Zod, Hono + Cloudflare Workers (sync-server), Loki/Grafana, Vitest, React + Radix (renderer), `@memry/rpc` codegen for IPC.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-18-diagnostic-logs-loki-design.md`. Every task's requirements implicitly include this section.

- **Redact before send.** No note content, titles, attachment filenames, absolute home/vault paths, emails, JWTs/tokens, vault/device keys, IPs. When in doubt, hash or drop.
- **Loki labels stay low-cardinality:** `{ app, env, level }` + one new fixed-set `kind` label (`error` / `log` / `report`). Everything else goes inside the JSON line. Never a high-cardinality label.
- **`apps/desktop/src/main/lib/logger.ts` must NOT import electron** (bundled into worker_threads; guarded by `apps/desktop/scripts/check-worker-bundles.mjs`). The redacting transport that calls `net.fetch` is installed from the **main process**, not from `logger.ts`. Worker-side forwarding helper must use only the `process.parentPort` runtime global — **no `import … from 'electron'`**.
- **Do not regress** `/telemetry/batch → desktopErrorEntry → Loki`. `/batch` stays untouched; new endpoints are added alongside it. The only change to the existing pipeline is the additive `kind: 'error'` label value.
- **Server before desktop.** The sync-server ingest change deploys and is live before any desktop build that sends to it. Old clients keep working (additive only). No new required server secret (reuse optional `LOKI_URL`/`LOKI_TOKEN` + existing `TELEMETRY_HMAC_KEY`).
- **Backward compatibility is mandatory** (LIVE users): no DB resets; additive-only changes; tolerate data written by older app versions.
- **Path A gate:** telemetry-enabled (reuse the existing toggle) AND build channel ∈ {staging, production} (not dev). **Server kill switch:** Loki unconfigured or endpoint disabled ⇒ client no-ops.
- **Path A level:** warn + error only (config-adjustable via `MEMRY_DIAG_LOG_LEVEL`); info not shipped in v1.
- **Hash salt:** per-install, persisted in `telemetry.json` (`diagnosticsSalt`). Server cannot reproduce it (mask-mode only).
- **Path B:** always requires explicit per-incident consent + a redacted preview that equals exactly what is sent.
- **Naming:** branch is `diagnostic-logs-loki`. No agent/tool branding in commits or PRs.
- **Verify gate (final):** `pnpm lint && pnpm typecheck && pnpm test && pnpm ipc:check`, `pnpm --filter @memry/desktop i18n:check`, `pnpm docs:impact --base <base_commit> --strict`, `pnpm docs:build`, `git diff --check`. Run `pnpm ipc:generate` before `pnpm ipc:check` after any contract/preload/handler edit.

---

## Phase 0 — Preconditions

- [ ] **Confirm the worktree + branch.** `git -C /Users/h4yfans/workspace/memry/.claude/worktrees/diagnostic-logs-loki-97bda6 branch --show-current` → `diagnostic-logs-loki`. Deps already installed (`pnpm install --frozen-lockfile` ran during setup).
- [ ] **Record the base commit** for the docs gate: `git merge-base HEAD origin/main` → use as `<base_commit>` in later `docs:impact` calls.

---

## Phase 1 — Shared redaction core (`packages/contracts`)

**Rationale:** Pure, crypto-free, unit-tested. Blocks both server (Phase 2) and desktop (Phases 3–5). The fuzz invariant here is the whole project's safety net.

### Task 1.1: Redaction module — text redaction

**Files:**

- Create: `packages/contracts/src/redact.ts`
- Test: `packages/contracts/src/redact.test.ts`

**Interfaces:**

- Produces: `redactText(text: string, opts?: RedactOptions): string`; `interface RedactOptions { vaultRoot?: string; hash?: (value: string) => string }`.

- [ ] **Step 1: Write failing tests** — `packages/contracts/src/redact.test.ts`:

```ts
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
    expect(redactText('Authorization: Bearer sk-abcdef0123456789abcdef')).not.toContain('sk-abcdef')
  })
  it('drops an sk- API key', () => {
    expect(redactText('using key sk-live-01234567890abcdefABCDEF')).not.toContain(
      '01234567890abcdef'
    )
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
})
```

- [ ] **Step 2: Run — expect FAIL** (`redact.ts` not found):
      `pnpm --filter @memry/contracts test -- redact.test.ts` → FAIL "Cannot find module './redact'".

- [ ] **Step 3: Implement `redact.ts`:**

```ts
// packages/contracts/src/redact.ts
//
// Pure, crypto-free redaction shared by desktop main (salted hasher injected) and
// the sync-server (mask-mode, defense-in-depth). No node/electron imports so it is
// safe in Cloudflare Workers, Node, and worker_threads bundles.

export interface RedactOptions {
  /** Active vault root (absolute) collapsed to <vault>/. */
  vaultRoot?: string
  /**
   * Salted one-way hash. When provided (desktop), correlatable placeholders are
   * produced: emails → [email:hash8], ids → hash, content basenames → [name:hash8].ext.
   * When omitted (server / pattern-only), values are masked to fixed placeholders
   * (<email>, <id>, [name].ext) — safe but non-correlatable.
   */
  hash?: (value: string) => string
}

// --- secret shapes (dropped, never hashed) ---
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const AUTH_ASSIGN =
  /\b(?:authorization|x-api-key|api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*\S+/gi
const API_KEY = /\b(?:sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g
const QUERY_SECRET =
  /([?&](?:token|key|secret|access_token|refresh_token|sig|signature|password|auth)=)[^&\s]+/gi
// base64/hex key material ≥ 40 chars (vault/device keys) — dropped
const LONG_SECRET = /\b[A-Za-z0-9+/=_-]{40,}\b/g

// --- structural shapes ---
const URL_QUERY = /(\bhttps?:\/\/[^\s?#]+)[?#]\S*/gi
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g
const IPV6 = /\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}\b/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const HOME_UNIX = /(?:\/Users\/|\/home\/)[^/\s:)'"]+|\/root(?=\/|\b)/g
const HOME_WIN = /[A-Za-z]:\\Users\\[^\\\s:)'"]+/gi
// content files (note/attachment) — hashed. Deliberately EXCLUDES code extensions
// (ts/js/tsx/mjs/…) so stack-frame file names survive as diagnostic signal.
const CONTENT_FILE =
  /([\p{L}\p{N}][\p{L}\p{N} ()._-]*)\.(md|markdown|pdf|txt|rtf|docx?|xlsx?|pptx?|csv|html?|json|png|jpe?g|gif|webp|svg|heic|tiff?|mp[34]|m4a|mov|zip)\b/giu

const mask = (opts: RedactOptions | undefined, kind: 'email' | 'id', raw: string): string => {
  if (!opts?.hash) return kind === 'email' ? '<email>' : '<id>'
  return kind === 'email' ? `[email:${opts.hash(raw).slice(0, 8)}]` : opts.hash(raw).slice(0, 10)
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const redactText = (text: string, opts?: RedactOptions): string => {
  if (!text) return text
  let out = text
  // 1. secrets first (drop) — order matters so nothing below hashes a secret.
  out = out.replace(JWT, '<redacted>')
  out = out.replace(AUTH_ASSIGN, '<redacted>')
  out = out.replace(BEARER, '<redacted>')
  out = out.replace(API_KEY, '<redacted>')
  out = out.replace(QUERY_SECRET, '$1<redacted>')
  // 2. URL query strip (keep scheme+host+path).
  out = out.replace(URL_QUERY, '$1')
  // 3. paths: home → ~, vault → <vault>.
  out = out.replace(HOME_UNIX, '~').replace(HOME_WIN, '~')
  if (opts?.vaultRoot) out = out.split(opts.vaultRoot).join('<vault>')
  // 4. content basenames → hashed/masked (before generic long-secret so titles hash).
  out = out.replace(CONTENT_FILE, (_m, base: string, ext: string) =>
    opts?.hash ? `[name:${opts.hash(base).slice(0, 8)}].${ext}` : `[name].${ext}`
  )
  // 5. emails, ids, ips.
  out = out.replace(EMAIL, (m) => mask(opts, 'email', m))
  out = out.replace(UUID, (m) => mask(opts, 'id', m))
  out = out.replace(IPV4, '<ip>').replace(IPV6, '<ip>')
  // 6. residual long secrets last (key material with no other shape).
  out = out.replace(LONG_SECRET, '<redacted>')
  return out
}

export const redactPathValue = (value: string, opts?: RedactOptions): string =>
  redactText(value, opts)
```

- [ ] **Step 4: Run — expect PASS.** `pnpm --filter @memry/contracts test -- redact.test.ts` → all green. If the `LONG_SECRET` rule nukes a legitimate long path segment in a test, confirm content-basename + path rules run first (they do) and the surviving assertion is about opaque key material only.

- [ ] **Step 5: Commit.** `git add packages/contracts/src/redact.ts packages/contracts/src/redact.test.ts && git commit -m "feat(contracts): redactText — crypto-free secret/path/email/id redaction"`

### Task 1.2: Redaction module — structured `redactLogLine` + allowlist

**Files:**

- Modify: `packages/contracts/src/redact.ts`
- Test: `packages/contracts/src/redact.test.ts`

**Interfaces:**

- Produces: `redactLogLine(input: { message: string; fields?: Record<string, unknown> }, opts?: RedactOptions): { message: string; fields: Record<string, unknown> }`. Also exports `VERBATIM_FIELD_KEYS`, `NUMERIC_FIELD_KEYS`, `ID_FIELD_KEYS`, `PATH_FIELD_KEYS` (readonly string arrays) for reuse/tests.

- [ ] **Step 1: Write failing tests** (append to `redact.test.ts`):

```ts
import { redactLogLine } from './redact'

describe('redactLogLine — allowlist + per-key strategy', () => {
  const opts = { hash }
  it('ships allowlisted keys verbatim', () => {
    const { fields } = redactLogLine(
      { message: 'x', fields: { scope: 'Sync', action: 'pull', level: 'warn' } },
      opts
    )
    expect(fields).toMatchObject({ scope: 'Sync', action: 'pull', level: 'warn' })
  })
  it('passes numeric metric keys through', () => {
    const { fields } = redactLogLine(
      { message: 'x', fields: { droppedCount: 12, durationMs: 40 } },
      opts
    )
    expect(fields).toMatchObject({ droppedCount: 12, durationMs: 40 })
  })
  it('hashes id keys even when not uuid-shaped', () => {
    const { fields } = redactLogLine(
      { message: 'x', fields: { noteId: 'abc123', signerDeviceId: 'dev-xyz' } },
      opts
    )
    expect(fields.noteId).not.toBe('abc123')
    expect(String(fields.noteId)).toMatch(/^h[0-9a-f]+$/)
  })
  it('redacts a path-key value (basename hashed, dir kept)', () => {
    const { fields } = redactLogLine(
      { message: 'x', fields: { filePath: '/home/u/MyVault/Attachments/report.pdf' } },
      { vaultRoot: '/home/u/MyVault', ...opts }
    )
    expect(String(fields.filePath)).toContain('<vault>/Attachments/')
    expect(String(fields.filePath)).not.toContain('report')
  })
  it('redacts unknown-key string values via redactText', () => {
    const { fields } = redactLogLine(
      { message: 'x', fields: { note: 'see Budget 2026.xlsx' } },
      opts
    )
    expect(String(fields.note)).not.toContain('Budget 2026')
  })
  it('redacts the message', () => {
    const { message } = redactLogLine({ message: 'blocked /Users/kaan/v/Q3 Report.pdf' }, opts)
    expect(message).not.toContain('kaan')
    expect(message).not.toContain('Q3 Report')
  })
  it('caps message length', () => {
    const { message } = redactLogLine({ message: 'a'.repeat(5000) }, opts)
    expect(message.length).toBeLessThanOrEqual(2000)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`redactLogLine` not exported).

- [ ] **Step 3: Implement** (append to `redact.ts`):

```ts
export const VERBATIM_FIELD_KEYS = [
  'level',
  'scope',
  'action',
  'errorCode',
  'appVersion',
  'buildChannel',
  'platform',
  'arch',
  'origin',
  'workerName',
  'reason',
  'phase',
  'mode',
  'status',
  'kind',
  'result'
] as const
export const NUMERIC_FIELD_KEYS = [
  'durationMs',
  'itemCount',
  'queueCount',
  'retryCount',
  'byteCount',
  'resultCount',
  'value',
  'count',
  'droppedCount',
  'sequenceNum',
  'pageCount',
  'attempt',
  'size',
  'exitCode'
] as const
export const ID_FIELD_KEYS = [
  'noteId',
  'journalId',
  'taskId',
  'projectId',
  'attachmentId',
  'deviceId',
  'vaultId',
  'signerDeviceId',
  'installId',
  'sessionId',
  'blockId',
  'itemId'
] as const
export const PATH_FIELD_KEYS = [
  'filePath',
  'path',
  'dir',
  'file',
  'attachmentPath',
  'url',
  'target'
] as const

const MESSAGE_CAP = 2000
const FIELD_VALUE_CAP = 500
const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)
const has = (arr: readonly string[], k: string): boolean => arr.includes(k)

const redactFieldValue = (key: string, value: unknown, opts?: RedactOptions): unknown => {
  if (has(VERBATIM_FIELD_KEYS, key))
    return typeof value === 'string' ? cap(value, FIELD_VALUE_CAP) : value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  const str = typeof value === 'string' ? value : safeStringify(value)
  if (has(ID_FIELD_KEYS, key) && str) return opts?.hash ? opts.hash(str).slice(0, 10) : '<id>'
  // path keys + unknown keys both flow through redactText; cap afterward.
  return cap(redactText(str, opts), FIELD_VALUE_CAP)
}

const safeStringify = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  } catch {
    return '<unserializable>'
  }
}

export const redactLogLine = (
  input: { message: string; fields?: Record<string, unknown> },
  opts?: RedactOptions
): { message: string; fields: Record<string, unknown> } => {
  const message = cap(redactText(input.message ?? '', opts), MESSAGE_CAP)
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    try {
      fields[key] = redactFieldValue(key, value, opts)
    } catch {
      fields[key] = '<redaction-error>'
    }
  }
  return { message, fields }
}
```

- [ ] **Step 4: Run — expect PASS.** `pnpm --filter @memry/contracts test -- redact.test.ts`.

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(contracts): redactLogLine — allowlist + per-key redaction strategy"`

### Task 1.3: The fuzz invariant + the three known lines (safety net)

**Files:**

- Test: `packages/contracts/src/redact.fuzz.test.ts`

**Interfaces:** consumes `redactLogLine`, `redactText` from Task 1.1–1.2. No new production code.

- [ ] **Step 1: Write the invariant test** — `packages/contracts/src/redact.fuzz.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { redactLogLine } from './redact'

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
  'sk-live-0123456789abcdefABCDEF0123',
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
```

- [ ] **Step 2: Run — expect PASS** (all production code already exists). `pnpm --filter @memry/contracts test -- redact.fuzz.test.ts`. If ANY assertion fails, the redactor has a hole — fix `redact.ts` (add/order a rule) before proceeding. This gate protects the entire feature.

- [ ] **Step 3: Commit.** `git add packages/contracts/src/redact.fuzz.test.ts && git commit -m "test(contracts): fuzz invariant + known-line redaction for diagnostic logs"`

---

## Phase 2 — Server ingest + contracts wire schemas (deploy first)

**Rationale:** Must be live before any desktop build POSTs to it. Contracts schemas here are shared by the client (Phases 4–5). `/batch` is untouched.

### Task 2.1: Wire-payload schemas (`diagnostics-api.ts`)

**Files:**

- Create: `packages/contracts/src/diagnostics-api.ts`
- Modify: `packages/contracts/src/index.ts` (add export if the package uses a barrel — check; contracts is imported by subpath `@memry/contracts/diagnostics-api`, so a barrel edit may be unnecessary)
- Test: `packages/contracts/src/diagnostics-api.test.ts`

**Interfaces:**

- Produces: `DiagnosticLogLineSchema`, `DiagnosticLogBatchSchema`, `DiagnosticReportSchema`, `DiagnosticSnapshotSchema` + inferred types `DiagnosticLogLine`, `DiagnosticLogBatch`, `DiagnosticReport`, `DiagnosticSnapshot`.

- [ ] **Step 1: Write failing tests** — `diagnostics-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DiagnosticLogBatchSchema, DiagnosticReportSchema } from './diagnostics-api'

const line = {
  ts: '2026-07-18T10:00:00.000Z',
  level: 'warn' as const,
  scope: 'Sync',
  message: 'x',
  origin: 'main' as const
}
const batchBase = {
  schemaVersion: 1 as const,
  installId: '1f2e3d4c-5b6a-7980-1122-334455667788',
  sessionId: '2f2e3d4c-5b6a-7980-1122-334455667788',
  appVersion: '2026.7.18',
  buildChannel: 'production' as const,
  platform: 'linux' as const,
  arch: 'x64'
}

describe('DiagnosticLogBatchSchema', () => {
  it('accepts a valid batch', () => {
    expect(DiagnosticLogBatchSchema.safeParse({ ...batchBase, lines: [line] }).success).toBe(true)
  })
  it('rejects an empty lines array', () => {
    expect(DiagnosticLogBatchSchema.safeParse({ ...batchBase, lines: [] }).success).toBe(false)
  })
  it('rejects > 50 lines', () => {
    expect(
      DiagnosticLogBatchSchema.safeParse({ ...batchBase, lines: Array(51).fill(line) }).success
    ).toBe(false)
  })
  it('rejects an info level (warn/error only)', () => {
    expect(
      DiagnosticLogBatchSchema.safeParse({ ...batchBase, lines: [{ ...line, level: 'info' }] })
        .success
    ).toBe(false)
  })
  it('rejects a message > 2000 chars', () => {
    expect(
      DiagnosticLogBatchSchema.safeParse({
        ...batchBase,
        lines: [{ ...line, message: 'a'.repeat(2001) }]
      }).success
    ).toBe(false)
  })
})

describe('DiagnosticReportSchema', () => {
  const report = {
    ...batchBase,
    incidentId: 'MEMRY-AB12CD34',
    trigger: { source: 'tab_error_boundary' },
    snapshot: {
      appVersion: '2026.7.18',
      buildChannel: 'production',
      platform: 'linux',
      arch: 'x64',
      locale: 'en',
      uptimeSeconds: 120,
      syncEnabled: true,
      syncState: 'enabled',
      queueDepth: 0,
      vaultOpen: true,
      authState: 'signed_in'
    },
    lines: [line]
  }
  it('accepts a valid report', () => {
    expect(DiagnosticReportSchema.safeParse(report).success).toBe(true)
  })
  it('rejects > 200 lines', () => {
    expect(
      DiagnosticReportSchema.safeParse({ ...report, lines: Array(201).fill(line) }).success
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm --filter @memry/contracts test -- diagnostics-api.test.ts`.

- [ ] **Step 3: Implement `diagnostics-api.ts`** (reuse `SafeDimensionValueSchema` shape from `telemetry-api.ts` for tokens):

```ts
import { z } from 'zod'
import {
  TelemetryAuthStateSchema,
  TelemetryBuildChannelSchema,
  TelemetryPlatformSchema,
  TelemetrySyncStateSchema
} from './telemetry-api'

const SAFE_TOKEN = /^(?!.*@)(?!.*:\/\/)(?!.*[/\\]).{1,64}$/
const SafeToken = z.string().regex(SAFE_TOKEN)
// bounded record of already-redacted primitive field values.
const SafeFields = z.record(
  z.string().max(64),
  z.union([z.string().max(500), z.number().finite(), z.boolean()])
)

export const DiagnosticLogLineSchema = z.object({
  ts: z.string().datetime(),
  level: z.enum(['warn', 'error']),
  scope: SafeToken,
  action: SafeToken.optional(),
  message: z.string().max(2000),
  errorCode: SafeToken.optional(),
  fields: SafeFields.optional(),
  origin: z.enum(['main', 'worker']),
  workerName: SafeToken.optional()
})

const clientMeta = {
  schemaVersion: z.literal(1),
  installId: z.string().uuid(),
  sessionId: z.string().uuid(),
  appVersion: z.string().min(1).max(32),
  buildChannel: TelemetryBuildChannelSchema,
  platform: TelemetryPlatformSchema,
  arch: z.string().min(1).max(32)
}

export const DiagnosticLogBatchSchema = z.object({
  ...clientMeta,
  lines: z.array(DiagnosticLogLineSchema).min(1).max(50)
})

export const DiagnosticSnapshotSchema = z.object({
  appVersion: z.string().max(32),
  buildChannel: TelemetryBuildChannelSchema,
  platform: TelemetryPlatformSchema,
  arch: z.string().max(32),
  locale: z.string().max(16),
  uptimeSeconds: z.number().finite().nonnegative(),
  syncEnabled: z.boolean(),
  syncState: TelemetrySyncStateSchema,
  queueDepth: z.number().int().nonnegative(),
  vaultOpen: z.boolean(),
  authState: TelemetryAuthStateSchema
})

export const DiagnosticReportSchema = z.object({
  ...clientMeta,
  incidentId: z.string().regex(/^MEMRY-[A-Z0-9]{6,12}$/),
  trigger: z.object({
    source: SafeToken,
    errorCode: SafeToken.optional(),
    stack: z.string().max(4000).optional()
  }),
  snapshot: DiagnosticSnapshotSchema,
  lines: z.array(DiagnosticLogLineSchema).max(200),
  accountId: z.string().uuid().optional()
})

export type DiagnosticLogLine = z.infer<typeof DiagnosticLogLineSchema>
export type DiagnosticLogBatch = z.infer<typeof DiagnosticLogBatchSchema>
export type DiagnosticSnapshot = z.infer<typeof DiagnosticSnapshotSchema>
export type DiagnosticReport = z.infer<typeof DiagnosticReportSchema>
```

- [ ] **Step 4: Run — expect PASS.** `pnpm --filter @memry/contracts test -- diagnostics-api.test.ts`.

- [ ] **Step 5: Commit.** `git add packages/contracts/src/diagnostics-api.ts packages/contracts/src/diagnostics-api.test.ts && git commit -m "feat(contracts): diagnostic log/report wire schemas"`

### Task 2.2: Loki entry mappers + `kind` label

**Files:**

- Modify: `apps/sync-server/src/services/loki.ts`
- Test: `apps/sync-server/src/services/loki.test.ts`

**Interfaces:**

- Consumes: `redactLogLine` (Phase 1, mask-mode — no hasher), `DiagnosticLogLine`, `DiagnosticReport` (Task 2.1).
- Produces: `desktopLogEntry(line, meta, installHash): LokiEntry`; `desktopReportEntry(report, installHash): LokiEntry[]`. `LokiEntry` gains `kind?: 'error' | 'log' | 'report'`; stream labels gain `kind`.

- [ ] **Step 1: Write failing tests** (append to `loki.test.ts`, mirror existing fetch-stub pattern):

```ts
import { desktopLogEntry, desktopReportEntry, pushLokiEntries } from './loki'

describe('kind label + diagnostic entries', () => {
  const env = { LOKI_URL: 'https://grafana.example.com', LOKI_TOKEN: 'tok', ENVIRONMENT: 'test' }
  const meta = {
    appVersion: '2026.7.18',
    buildChannel: 'production',
    platform: 'linux',
    arch: 'x64'
  } as const

  it('desktopLogEntry carries kind=log + a redacted message', () => {
    const entry = desktopLogEntry(
      {
        ts: '2026-07-18T10:00:00.000Z',
        level: 'warn',
        scope: 'Sync',
        message: 'pull_page_dropped',
        origin: 'main',
        fields: { droppedCount: 3 }
      },
      meta,
      'installhash'
    )
    expect(entry.kind).toBe('log')
    expect(entry.level).toBe('warn')
    expect(entry.line.message).toBe('pull_page_dropped')
  })

  it('server mask-mode scrubs a leaked email defense-in-depth', () => {
    const entry = desktopLogEntry(
      {
        ts: '2026-07-18T10:00:00.000Z',
        level: 'error',
        scope: 'X',
        message: 'oops leak@evil.com',
        origin: 'main'
      },
      meta,
      'h'
    )
    expect(JSON.stringify(entry.line)).not.toContain('leak@evil.com')
  })

  it('pushLokiEntries emits kind in the stream labels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await pushLokiEntries(env, [
      desktopLogEntry(
        { ts: '2026-07-18T10:00:00.000Z', level: 'warn', scope: 'S', message: 'm', origin: 'main' },
        meta,
        'h'
      )
    ])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.streams[0].stream).toMatchObject({ app: 'desktop', level: 'warn', kind: 'log' })
    vi.unstubAllGlobals()
  })

  it('desktopReportEntry stamps incident_id on every line', () => {
    const entries = desktopReportEntry(
      {
        schemaVersion: 1,
        installId: 'i',
        sessionId: 's',
        appVersion: '1',
        buildChannel: 'production',
        platform: 'linux',
        arch: 'x64',
        incidentId: 'MEMRY-AB12CD34',
        trigger: { source: 'boundary' },
        snapshot: {} as never,
        lines: [
          {
            ts: '2026-07-18T10:00:00.000Z',
            level: 'warn',
            scope: 'S',
            message: 'm',
            origin: 'main'
          }
        ]
      },
      'h'
    )
    expect(
      entries.every((e) => e.kind === 'report' && e.line.incident_id === 'MEMRY-AB12CD34')
    ).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm --filter @memry/sync-server test -- loki.test.ts`.

- [ ] **Step 3: Implement.** In `loki.ts`: (a) add `kind` to `LokiEntry` and to the stream labels; (b) set `kind: 'error'` in `desktopErrorEntry`; (c) add the two new mappers using mask-mode `redactLogLine`:

```ts
import { redactLogLine } from '@memry/contracts/redact'
import type { DiagnosticLogLine, DiagnosticReport } from '@memry/contracts/diagnostics-api'

export interface LokiEntry {
  level: 'warn' | 'error'
  app: 'desktop' | 'server'
  kind?: 'error' | 'log' | 'report'
  line: Record<string, unknown>
}
// in pushLokiEntries stream mapping:
//   stream: { app: entry.app, env: env.ENVIRONMENT ?? 'unknown', level: entry.level, kind: entry.kind ?? 'error' },
// in desktopErrorEntry: add `kind: 'error'` to the returned object.

interface DesktopMeta {
  appVersion: string
  buildChannel: string
  platform: string
  arch: string
}

export const desktopLogEntry = (
  line: DiagnosticLogLine,
  meta: DesktopMeta,
  installHash: string
): LokiEntry => {
  // Defense-in-depth: client already redacted; re-run mask-mode (no hasher) to scrub
  // anything that slipped through. Never throws.
  const safe = redactLogLine({ message: line.message, fields: line.fields }, {})
  return {
    level: line.level,
    app: 'desktop',
    kind: 'log',
    line: {
      ts: line.ts,
      scope: line.scope,
      action: line.action ?? '',
      message: safe.message,
      error_code: line.errorCode ?? '',
      origin: line.origin,
      worker_name: line.workerName ?? '',
      fields: safe.fields,
      app_version: meta.appVersion,
      build_channel: meta.buildChannel,
      platform: meta.platform,
      install_hash: installHash
    }
  }
}

export const desktopReportEntry = (report: DiagnosticReport, installHash: string): LokiEntry[] => {
  const summary: LokiEntry = {
    level: 'error',
    app: 'desktop',
    kind: 'report',
    line: {
      incident_id: report.incidentId,
      kind: 'summary',
      trigger_source: report.trigger.source,
      trigger_error_code: report.trigger.errorCode ?? '',
      trigger_stack: redactLogLine({ message: report.trigger.stack ?? '' }, {}).message,
      snapshot: report.snapshot,
      app_version: report.appVersion,
      build_channel: report.buildChannel,
      platform: report.platform,
      install_hash: installHash
    }
  }
  const lines = report.lines.map((l) => {
    const e = desktopLogEntry(
      l,
      {
        appVersion: report.appVersion,
        buildChannel: report.buildChannel,
        platform: report.platform,
        arch: report.arch
      },
      installHash
    )
    e.kind = 'report'
    e.line.incident_id = report.incidentId
    return e
  })
  return [summary, ...lines]
}
```

- [ ] **Step 4: Run — expect PASS.** `pnpm --filter @memry/sync-server test -- loki.test.ts` (and re-run the existing `desktopErrorEntry` tests — the added `kind:'error'` must not break them; update their expected stream label to include `kind: 'error'`).

- [ ] **Step 5: Commit.** `git add apps/sync-server/src/services/loki.ts apps/sync-server/src/services/loki.test.ts && git commit -m "feat(sync-server): kind label + desktopLogEntry/desktopReportEntry Loki mappers"`

### Task 2.3: Ingest routes `/telemetry/logs` + `/diagnostics/report`

**Files:**

- Modify: `apps/sync-server/src/routes/telemetry.ts` (add `POST /logs`)
- Create: `apps/sync-server/src/routes/diagnostics.ts` (`POST /report`)
- Modify: `apps/sync-server/src/index.ts` (mount `diagnostics` router; add `/diagnostics/` to `getMaxBodyBytes` at the 128 KB tier)
- Test: `apps/sync-server/src/routes/telemetry.test.ts`, `apps/sync-server/src/routes/diagnostics.test.ts`

**Interfaces:**

- Consumes: `DiagnosticLogBatchSchema`, `DiagnosticReportSchema` (2.1); `desktopLogEntry`, `desktopReportEntry`, `pushLokiEntries` (2.2); `hashTelemetryId`, `safeWaitUntil`, `createRateLimiter`, `AppError`, `ErrorCodes`.

- [ ] **Step 1: Write failing route tests** — `telemetry.test.ts` (add) + `diagnostics.test.ts` (mirror the existing harness: mock rate-limit to pass-through, `createEnv` with `LOKI_URL/LOKI_TOKEN`, `app.request`, `findLokiCall` scan):

```ts
// diagnostics.test.ts
vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}))
import { app } from '../index'

const env = () => ({
  LOKI_URL: 'https://grafana.example.com',
  LOKI_TOKEN: 'tok',
  ENVIRONMENT: 'development',
  TELEMETRY_HMAC_KEY: 'k',
  DB: {}
})
const post = (path: string, body: unknown, e = env()) =>
  app.request(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    {},
    e
  )

const validReport = {
  schemaVersion: 1,
  installId: '1f2e3d4c-5b6a-7980-1122-334455667788',
  sessionId: '2f2e3d4c-5b6a-7980-1122-334455667788',
  appVersion: '2026.7.18',
  buildChannel: 'production',
  platform: 'linux',
  arch: 'x64',
  incidentId: 'MEMRY-AB12CD34',
  trigger: { source: 'boundary' },
  snapshot: {
    appVersion: '1',
    buildChannel: 'production',
    platform: 'linux',
    arch: 'x64',
    locale: 'en',
    uptimeSeconds: 1,
    syncEnabled: false,
    syncState: 'disabled',
    queueDepth: 0,
    vaultOpen: true,
    authState: 'anonymous'
  },
  lines: []
}

describe('POST /diagnostics/report', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('202 + pushes a report to Loki', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await post('/diagnostics/report', validReport)
    expect(res.status).toBe(202)
    expect((await res.json()).incidentId).toBe('MEMRY-AB12CD34')
  })
  it('400 on invalid payload', async () => {
    expect((await post('/diagnostics/report', { bad: true })).status).toBe(400)
  })
  it('no-op (still 202) when Loki unconfigured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const res = await post('/diagnostics/report', validReport, {
      ...env(),
      LOKI_URL: undefined,
      LOKI_TOKEN: undefined
    })
    expect(res.status).toBe(202)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

Add an analogous `POST /telemetry/logs` block to `telemetry.test.ts` (valid `DiagnosticLogBatch` → 202 + `desktopLogEntry` push; invalid → 400; Loki-unset → 202 no fetch; assert `keyPrefix: 'telemetry-logs'`).

- [ ] **Step 2: Run — expect FAIL** (routes 404). `pnpm --filter @memry/sync-server test -- diagnostics.test.ts telemetry.test.ts`.

- [ ] **Step 3: Implement.** `telemetry.ts` — add after the `/batch` block:

```ts
import { DiagnosticLogBatchSchema } from '@memry/contracts/diagnostics-api'
import { desktopLogEntry } from '../services/loki'

telemetry.use(
  '/logs',
  createRateLimiter({ maxRequests: 120, windowSeconds: 60, keyPrefix: 'telemetry-logs' })
)
telemetry.post('/logs', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = DiagnosticLogBatchSchema.safeParse(body)
  if (!parsed.success) {
    logger.warn('Invalid diagnostic log batch', {
      issues: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || '(root)'}:${i.code}`)
    })
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid diagnostic log batch', 400)
  }
  const batch = parsed.data
  const meta = {
    appVersion: batch.appVersion,
    buildChannel: batch.buildChannel,
    platform: batch.platform,
    arch: batch.arch
  }
  safeWaitUntil(
    c,
    hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, batch.installId).then((installHash) =>
      pushLokiEntries(
        c.env,
        batch.lines.map((line) => desktopLogEntry(line, meta, installHash))
      )
    )
  )
  return c.json({ accepted: batch.lines.length }, 202)
})
```

`diagnostics.ts` — new router:

```ts
import { Hono } from 'hono'
import { DiagnosticReportSchema } from '@memry/contracts/diagnostics-api'
import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { createRateLimiter } from '../middleware/rate-limit'
import { safeWaitUntil } from '../services/analytics'
import { desktopReportEntry, pushLokiEntries } from '../services/loki'
import { hashTelemetryId } from '../services/telemetry'
import type { AppContext } from '../types'

const logger = createLogger('Diagnostics')
export const diagnostics = new Hono<AppContext>()

diagnostics.use(
  '/report',
  createRateLimiter({ maxRequests: 10, windowSeconds: 3600, keyPrefix: 'diagnostics' })
)
diagnostics.post('/report', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = DiagnosticReportSchema.safeParse(body)
  if (!parsed.success) {
    logger.warn('Invalid diagnostic report', {
      issues: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.') || '(root)'}:${i.code}`)
    })
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid diagnostic report', 400)
  }
  const report = parsed.data
  safeWaitUntil(
    c,
    hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, report.installId).then((installHash) =>
      pushLokiEntries(c.env, desktopReportEntry(report, installHash))
    )
  )
  return c.json({ incidentId: report.incidentId }, 202)
})
```

`index.ts` — import + mount `app.route('/diagnostics', diagnostics)`; in `getMaxBodyBytes` add `if (path.startsWith('/diagnostics/')) return MAX_BODY_BYTES_TELEMETRY` (128 KB) so a report can't exceed the cap.

- [ ] **Step 4: Run — expect PASS.** `pnpm --filter @memry/sync-server test`.

- [ ] **Step 5: Commit.** `git add apps/sync-server && git commit -m "feat(sync-server): /telemetry/logs + /diagnostics/report ingest endpoints"`

### Task 2.4: Server gate + deploy

- [ ] **Step 1: Full server verify.** `pnpm --filter @memry/sync-server typecheck && pnpm --filter @memry/sync-server test`.
- [ ] **Step 2: Merge Phase 1+2 to main** (contracts + sync-server only, no desktop sender yet). Open the PR as draft per repo default unless told otherwise. This is backward compatible — old desktop clients never call the new endpoints.
- [ ] **Step 3: Deploy staging** (auto on push to `main` touching `apps/sync-server/**` via `.github/workflows/sync-server-deploy-staging.yml`), then **production** (`.github/workflows/sync-server-deploy-production.yml`, manual `workflow_dispatch`). Confirm `LOKI_TOKEN` secret is set for both envs (`wrangler secret list --env <env>`). **Do not proceed to desktop rollout (Phase 6) until production ingest is live** — verify with a manual `curl` of `/telemetry/logs` against production returning 202.

---

## Phase 3 — Desktop: per-install salt

### Task 3.1: `diagnosticsSalt` persistence + salted hasher

**Files:**

- Modify: `apps/desktop/src/main/telemetry/config.ts` (add `diagnosticsSalt?: string` to `TelemetryConfigOnDisk`)
- Create: `apps/desktop/src/main/telemetry/diagnostics-salt.ts`
- Test: `apps/desktop/src/main/telemetry/diagnostics-salt.test.ts`

**Interfaces:**

- Produces: `getOrCreateDiagnosticsSalt(): string`; `makeSaltedHasher(salt: string): (value: string) => string`.

- [ ] **Step 1: Failing test** — `diagnostics-salt.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { makeSaltedHasher } from './diagnostics-salt'

describe('makeSaltedHasher', () => {
  it('is deterministic per salt and 10 hex chars', () => {
    const h = makeSaltedHasher('salt-A')
    expect(h('x')).toBe(h('x'))
    expect(h('x')).toMatch(/^[0-9a-f]{10}$/)
  })
  it('differs across salts (per-install privacy)', () => {
    expect(makeSaltedHasher('A')('x')).not.toBe(makeSaltedHasher('B')('x'))
  })
})
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm --filter @memry/desktop test:main -- diagnostics-salt.test.ts`.

- [ ] **Step 3: Implement** — add `diagnosticsSalt?: string` to `TelemetryConfigOnDisk` in `config.ts`; create `diagnostics-salt.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'
import { mergeTelemetryConfig, readTelemetryConfig } from './config'

export const getOrCreateDiagnosticsSalt = (): string => {
  const existing = readTelemetryConfig().diagnosticsSalt
  if (typeof existing === 'string' && /^[0-9a-f]{32}$/.test(existing)) return existing
  const fresh = randomBytes(16).toString('hex')
  mergeTelemetryConfig({ diagnosticsSalt: fresh })
  return fresh
}

export const makeSaltedHasher =
  (salt: string) =>
  (value: string): string =>
    createHash('sha256').update(salt).update('\0').update(value).digest('hex').slice(0, 10)
```

- [ ] **Step 4: Run — expect PASS.** `pnpm --filter @memry/desktop test:main -- diagnostics-salt.test.ts`.
- [ ] **Step 5: Commit.** `git add apps/desktop/src/main/telemetry/config.ts apps/desktop/src/main/telemetry/diagnostics-salt.ts apps/desktop/src/main/telemetry/diagnostics-salt.test.ts && git commit -m "feat(desktop): per-install diagnostics salt + salted hasher"`

---

## Phase 4 — Path A: redacting log-ship transport + worker forwarding

### Task 4.1: Ship queue (parallel to telemetry client, own tests)

**Rationale:** A parallel queue — NOT a refactor of `client.ts` — keeps the working telemetry pipeline untouched (non-negotiable).

**Files:**

- Create: `apps/desktop/src/main/telemetry/ship-queue.ts`
- Test: `apps/desktop/src/main/telemetry/ship-queue.test.ts`

**Interfaces:**

- Produces: `createShipQueue<T>(deps: { fetch: TelemetryFetch; endpoint: string; buildBody: (items: T[]) => unknown; queueLimit?: number; batchLimit?: number }): { enqueue(item: T): void; flush(): Promise<{ success: boolean; attempted: number; accepted: number }>; depth(): number; setEnabled(b: boolean): void }`. Reuse `TelemetryFetch` type from `./client`.

- [ ] **Step 1: Failing tests** — mirror `client.test.ts` semantics (batch ≤ 50, queue trim at 500, drop 4xx≠429, keep 5xx/429, no-op when disabled):

```ts
import { describe, expect, it, vi } from 'vitest'
import { createShipQueue } from './ship-queue'

const okFetch = vi.fn(async () => ({ ok: true, status: 202 }))
const make = (fetch = okFetch) =>
  createShipQueue<number>({ fetch, endpoint: 'https://x/logs', buildBody: (items) => ({ items }) })

describe('createShipQueue', () => {
  it('does nothing when disabled', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 202 }))
    const q = make(f)
    q.setEnabled(false)
    q.enqueue(1)
    expect(await q.flush()).toMatchObject({ attempted: 0 })
    expect(f).not.toHaveBeenCalled()
  })
  it('flushes a batch and clears on 2xx', async () => {
    const q = make()
    q.setEnabled(true)
    q.enqueue(1)
    q.enqueue(2)
    expect(await q.flush()).toMatchObject({ success: true, accepted: 2 })
    expect(q.depth()).toBe(0)
  })
  it('drops the batch on a 400 (poison line)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 400 }))
    const q = make(f)
    q.setEnabled(true)
    q.enqueue(1)
    await q.flush()
    expect(q.depth()).toBe(0)
  })
  it('keeps the batch on a 500 (transient)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500 }))
    const q = make(f)
    q.setEnabled(true)
    q.enqueue(1)
    await q.flush()
    expect(q.depth()).toBe(1)
  })
  it('trims to the queue limit', () => {
    const q = createShipQueue<number>({
      fetch: okFetch,
      endpoint: 'x',
      buildBody: (i) => i,
      queueLimit: 3
    })
    q.setEnabled(true)
    for (let i = 0; i < 10; i++) q.enqueue(i)
    expect(q.depth()).toBe(3)
  })
})
```

- [ ] **Step 2–4:** Run FAIL → implement `ship-queue.ts` (copy the proven semantics from `client.ts` lines 61–177, generic over `T`, batch limit 50, queue limit 500) → run PASS. `pnpm --filter @memry/desktop test:main -- ship-queue.test.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat(desktop): generic ship-queue mirroring telemetry client retry semantics"`

### Task 4.2: Log-ship transport (redact + throttle + ring-buffer feed)

**Files:**

- Create: `apps/desktop/src/main/telemetry/log-ship.ts`
- Test: `apps/desktop/src/main/telemetry/log-ship.test.ts`

**Interfaces:**

- Consumes: `redactLogLine` (contracts), `makeSaltedHasher`/`getOrCreateDiagnosticsSalt` (3.1), `createShipQueue` (4.1), `getCurrentVaultPath` (`../store`), `getTelemetryRuntime` (`./runtime`), `DiagnosticLogLine` (contracts).
- Produces: `installLogShip(deps): { dispose(): Promise<void>; ingestForwarded(record: RawLogRecord, workerName: string): void; recentLines(): DiagnosticLogLine[] }`; `type RawLogRecord = { level: string; scope?: string; data: unknown[]; date?: string }`. Also `parseRecord(record): { level; scope; message; fields }` (exported for tests).

- [ ] **Step 1: Failing tests** — cover: warn/error captured, info/debug dropped; message+fields redacted (no raw path); re-entrancy scopes skipped; disabled ⇒ nothing enqueued; ring buffer bounded:

```ts
import { describe, expect, it, vi } from 'vitest'
import { parseRecord } from './log-ship'

describe('parseRecord', () => {
  it('splits the first string arg as message and merges object args as fields', () => {
    const p = parseRecord({
      level: 'warn',
      scope: 'Sync',
      data: ['blocked path', { filePath: '/Users/kaan/v/x.md' }]
    })
    expect(p.message).toBe('blocked path')
    expect(p.fields.filePath).toBe('/Users/kaan/v/x.md')
  })
})
```

Plus an integration test constructing `installLogShip` with a fake fetch + fake salt + `vaultRoot` and asserting a `log.warn('m', { filePath })`-shaped record enqueues a redacted line and that a record with scope `LogShip` is ignored. (Drive it through the exported transport function rather than a real `electron-log`.)

- [ ] **Step 2–3: Implement `log-ship.ts`.** Core shape:

```ts
import log from 'electron-log'
import { redactLogLine, type DiagnosticLogLine } from '@memry/contracts/redact' // redactLogLine from redact; DiagnosticLogLine from diagnostics-api
import { getCurrentVaultPath } from '../store'
import { getOrCreateDiagnosticsSalt, makeSaltedHasher } from './diagnostics-salt'
import { getTelemetryRuntime } from './runtime'
import { createShipQueue } from './ship-queue'

const SKIP_SCOPES = new Set(['LogShip', 'Telemetry', 'Loki'])
const RING_LIMIT = 200
const RING_MS = 5 * 60 * 1000
const DEFAULT_LEVEL = 'warn'
const LEVEL_ORDER: Record<string, number> = {
  error: 50,
  warn: 40,
  info: 30,
  verbose: 20,
  debug: 10,
  silly: 0
}

export type RawLogRecord = { level: string; scope?: string; data: unknown[]; date?: string }

export const parseRecord = (
  r: RawLogRecord
): { level: 'warn' | 'error'; scope: string; message: string; fields: Record<string, unknown> } => {
  const level = r.level === 'error' ? 'error' : 'warn'
  const scope = r.scope || 'app'
  let message = ''
  const fields: Record<string, unknown> = {}
  for (const arg of r.data) {
    if (typeof arg === 'string' && !message) message = arg
    else if (arg && typeof arg === 'object' && !(arg instanceof Error)) Object.assign(fields, arg)
    else if (arg instanceof Error) {
      if (!message) message = arg.name
      fields.errorName = arg.name
    } else if (!message) message = String(arg)
  }
  return { level, scope, message, fields }
}
// installLogShip: builds salted hasher once; threshold from MEMRY_DIAG_LOG_LEVEL||warn;
//   registers log.transports.logShip = (msg) => { guard SKIP_SCOPES; guard level<threshold;
//   re-entrancy flag; const vaultRoot = getCurrentVaultPath() ?? undefined;
//   const { message, fields } = redactLogLine(parseRecord(msg), { vaultRoot, hash });
//   const line: DiagnosticLogLine = { ts: new Date().toISOString(), level, scope, message, fields, origin:'main' };
//   pushRing(line); if (enabled()) queue.enqueue(line) }
//   transport.level = threshold so electron-log pre-filters.
// enabled() = getTelemetryRuntime()?.getSettings().enabled === true.
// ingestForwarded(record, workerName): same redaction path with origin:'worker', workerName.
// throttle: collapse identical (scope+level+message) within 3s, increment a repeat count field.
// dispose(): clear interval + final queue.flush(); remove the transport.
```

Gating on build channel: `installLogShip` accepts `buildChannel`; if `development`, the transport still fills the ring buffer (for Path B dev testing) but `queue.setEnabled(false)` so nothing ships in dev.

- [ ] **Step 4: Run — expect PASS.** `pnpm --filter @memry/desktop test:main -- log-ship.test.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat(desktop): redacting log-ship transport (Path A) + ring buffer"`

### Task 4.3: Install the transport at startup

**Files:**

- Modify: `apps/desktop/src/main/index.ts` (after `initializeTelemetryRuntime(...)` at ~line 1131)
- Test: covered by 4.2 unit tests + the Phase 6 E2E; no new unit test for the one-line wiring.

- [ ] **Step 1: Edit `index.ts`.** After the `initializeTelemetryRuntime({...})` call and before `registerMainDiagnostics()`:

```ts
const logShip = installLogShip({
  buildChannel: resolveMemryEnvironment(),
  endpoint: resolveDiagnosticsLogEndpoint(), // sync base + '/telemetry/logs'; mirror resolveEndpoint in runtime.ts
  salt: getOrCreateDiagnosticsSalt()
})
```

Hold `logShip` in module scope; call `await logShip.dispose()` next to `disposeTelemetryRuntime()` at shutdown (~line 1695). Add the import at the top. `resolveDiagnosticsLogEndpoint` derives from the same env chain as `resolveEndpoint` (`TELEMETRY_ENDPOINT`/`SYNC_SERVER_URL`/production default `https://sync.memrynote.com`), swapping the path to `/telemetry/logs`.

- [ ] **Step 2: Verify** `pnpm --filter @memry/desktop typecheck:node`.
- [ ] **Step 3: Commit.** `git commit -am "feat(desktop): install log-ship transport at main startup"`

### Task 4.4: Worker log forwarding

**Files:**

- Create: `apps/desktop/src/main/lib/log-forward.ts` (electron-free; `process.parentPort` only)
- Modify worker entries: `embedding-worker.ts`, `inbox/voice-transcription-worker.ts`, `image-processing/worker.ts` (install the forwarder)
- Modify bridges: `lib/embeddings.ts:356`, `inbox/voice-model.ts:245`, `image-processing/bridge.ts:228` (route `message.type === 'log'` → `logShip.ingestForwarded`)
- Modify: `apps/desktop/scripts/check-worker-bundles.mjs` (add `embedding-worker.js` to `WORKER_ENTRIES`)
- Test: `apps/desktop/src/main/lib/log-forward.test.ts`

**Interfaces:**

- Produces: `installWorkerLogForwarding(workerName: string): void` (worker side, guarded on `process.parentPort`); message shape `{ type: 'log', record: RawLogRecord }`.

- [ ] **Step 1: Failing test** — `log-forward.test.ts`: stub a fake `process.parentPort` with a `postMessage` spy; assert installing the forwarder + calling `log.warn('m', { a: 1 })` posts `{ type: 'log', record: { level:'warn', scope, data:['m',{a:1}] } }`; assert nothing posts when `process.parentPort` is undefined.

- [ ] **Step 2–3: Implement `log-forward.ts`:**

```ts
import log from 'electron-log' // electron-log, NOT electron — allowed in worker bundles

export const installWorkerLogForwarding = (workerName: string): void => {
  const port = (process as unknown as { parentPort?: { postMessage: (m: unknown) => void } })
    .parentPort
  if (!port) return
  ;(log.transports as Record<string, unknown>).forwardToMain = Object.assign(
    (message: { level: string; scope?: string; data: unknown[] }) => {
      if (LEVEL_ORDER[message.level] < LEVEL_ORDER.warn) return
      try {
        port.postMessage({
          type: 'log',
          record: {
            level: message.level,
            scope: message.scope ?? workerName,
            data: sanitizeArgs(message.data)
          }
        })
      } catch {
        /* forwarding is best-effort */
      }
    },
    { level: 'warn' as const }
  )
}
// sanitizeArgs: shallow-clone args to structured-cloneable primitives/objects; drop functions;
// stringify Errors to { name } so postMessage never throws DataCloneError.
```

Worker entries: call `installWorkerLogForwarding('Embeddings' | 'VoiceTranscription' | 'ImageProcessing')` right after the `parentPort` guard.

Bridges: in each `setupProcessHandlers(child)` add, **before** the `'requestId' in message` check:

```ts
if (message.type === 'log') {
  getLogShip()?.ingestForwarded(message.record, WORKER_NAME)
  return
}
```

Expose the singleton `logShip` via a small accessor `getLogShip()` from `log-ship.ts` (set on install). Also add the same `type:'log'` forward inside each bridge's **pre-ready** temporary `onMessage` so early worker warnings aren't dropped.

- [ ] **Step 4: Run.** `pnpm --filter @memry/desktop test:main -- log-forward.test.ts`. Then build + guard: `pnpm --filter @memry/desktop build && node apps/desktop/scripts/check-worker-bundles.mjs` (must be green — confirms `log-forward.ts` and worker entries stay electron-free).
- [ ] **Step 5: Commit.** `git commit -am "feat(desktop): forward worker warn/error logs to main log-ship via message port"`

### Task 4.5: `pull_page_dropped` observability

**Files:**

- Modify: `apps/desktop/src/main/sync/engine/pull-coordinator.ts:452-456`
- Test: `apps/desktop/src/main/sync/engine/pull-coordinator.test.ts` (add a case; if none exists, add a focused test around `processPage`)

- [ ] **Step 1: Failing test** — feed `processPage` a page whose `RecordPullResponseSchema.safeParse` fails and assert a `log.warn('pull_page_dropped', …)` fires with `droppedCount = itemIds.length` (spy on the module logger). Coordinate with the unmerged `sync-pull-cursor-fix` branch: this is additive logging only — do NOT change the cursor-advance at line 224.

- [ ] **Step 2–3: Implement.** At lines 453–456, keep the existing `log.error('Invalid pull response from server', …)` and add immediately after it, before the drop `return`:

```ts
log.warn('pull_page_dropped', { reason: 'invalid_pull_response', droppedCount: itemIds.length })
```

(`itemIds` is in scope at the drop site per the pull-coordinator recon; if the local is named differently, use the in-scope count of items on the page.)

- [ ] **Step 4: Run.** `pnpm --filter @memry/desktop test:main -- pull-coordinator.test.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat(desktop): emit pull_page_dropped diagnostic at the silent pull-page drop"`

---

## Phase 5 — Path B: opt-in incident report

### Task 5.1: Incident report assembler (main)

**Files:**

- Create: `apps/desktop/src/main/diagnostics/incident-report.ts`
- Test: `apps/desktop/src/main/diagnostics/incident-report.test.ts`

**Interfaces:**

- Consumes: `logShip.recentLines()` (ring buffer), `getTelemetryRuntime()` (settings/context), `getVaultStatus` (`../vault`), `redactLogLine` (for the trigger stack).
- Produces: `buildIncidentReport(trigger: IncidentTrigger, deps): DiagnosticReport` (pure given injected deps); `sendIncidentReport(report, deps): Promise<{ incidentId: string }>`; `generateIncidentId(rand): string` → `MEMRY-` + 8 base32 chars. `interface IncidentTrigger { source: string; errorCode?: string; stack?: string }`.

- [ ] **Step 1: Failing tests** — `incident-report.test.ts`: `buildIncidentReport` returns a report whose `lines` equal the injected redacted ring buffer, whose `snapshot` reflects injected sync/vault state, and whose `trigger.stack` is redacted (frames only, no home path). `generateIncidentId` matches `/^MEMRY-[A-Z2-7]{8}$/`. `sendIncidentReport` POSTs to `/diagnostics/report` and returns the id; a non-ok response throws.

- [ ] **Step 2–3: Implement.** `buildIncidentReport` pulls `recentLines()` (already redacted), builds `DiagnosticSnapshot` from `getVaultStatus()` + telemetry context + `process.uptime()`, redacts the trigger stack with `keepStackFrameLines`-style filtering (reuse `buildErrorDetail` from `@memry/contracts/telemetry-api` for the stack), and stamps a fresh `incidentId`. `sendIncidentReport` uses `net.fetch` (injected) to POST the validated `DiagnosticReport`.

- [ ] **Step 4: Run.** `pnpm --filter @memry/desktop test:main -- incident-report.test.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat(desktop): incident-report assembler (Path B) — build + send"`

### Task 5.2: IPC contract — `diagnostics` RPC domain

> **Use the `ipc-contract-change` skill for this task.**

**Files:**

- Modify: `packages/contracts/src/ipc-channels.ts` (add `DiagnosticsChannels`)
- Create: `packages/rpc/src/diagnostics.ts` (`defineDomain`)
- Modify: `packages/rpc/src/index.ts` (register in `rpcDomains` + `GeneratedRpcApi`)
- Modify: `packages/rpc/src/index.test.ts` (bump `rpcDomains` length 7 → 8 + name list)
- Regenerate: `apps/desktop/src/preload/generated-rpc.ts`, `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`

**Interfaces:**

- Produces channels `diagnostics:previewReport`, `diagnostics:sendReport`; client methods `window.api.diagnostics.previewReport(trigger) → Promise<DiagnosticReport>`, `sendReport(report) → Promise<{ incidentId: string }>`.

- [ ] **Step 1:** Add to `ipc-channels.ts` (near `TelemetryChannels`, ~line 812):

```ts
export const DiagnosticsChannels = {
  invoke: { PREVIEW_REPORT: 'diagnostics:previewReport', SEND_REPORT: 'diagnostics:sendReport' }
} as const
export type DiagnosticsInvokeChannel =
  (typeof DiagnosticsChannels.invoke)[keyof typeof DiagnosticsChannels.invoke]
```

- [ ] **Step 2:** Create `packages/rpc/src/diagnostics.ts` mirroring `telemetry.ts` (import `DiagnosticsChannels` via the same relative path telemetry.ts uses), with `previewReport`/`sendReport` methods + `DiagnosticsClientAPI`. Register in `packages/rpc/src/index.ts` (`rpcDomains` + `GeneratedRpcApi`). Update `index.test.ts`.
- [ ] **Step 3:** `pnpm ipc:generate` then `pnpm ipc:check` — expect green (or fix until green).
- [ ] **Step 4:** `pnpm --filter @memry/rpc test`.
- [ ] **Step 5: Commit.** `git commit -am "feat(contracts,rpc): diagnostics IPC domain (previewReport/sendReport)"`

### Task 5.3: Main IPC handlers

**Files:**

- Create: `apps/desktop/src/main/ipc/diagnostics-handlers.ts` (mirror `telemetry-handlers.ts`: `registerDiagnosticsHandlers()` / `unregisterDiagnosticsHandlers()`)
- Modify: `apps/desktop/src/main/ipc/index.ts` (import + call at ~line 142 inside `registerAllHandlers`; teardown at ~line 189)
- Test: `apps/desktop/src/main/ipc/diagnostics-handlers.test.ts`

**Interfaces:**

- `previewReport` handler → `buildIncidentReport(trigger, …)`; `sendReport` handler → `sendIncidentReport(report, …)`. Zod-validate inputs with `DiagnosticReportSchema`/a trigger schema; return `{ success:false, error }` envelopes on failure (match telemetry handler shape so the generated invoke map types are stable).

- [ ] **Step 1–4: TDD.** Test: `previewReport` returns a report from a stubbed assembler; `sendReport` forwards to the assembler and returns `{ incidentId }`. Implement handlers + wire into `registerAllHandlers`. Run `pnpm ipc:generate && pnpm ipc:check && pnpm --filter @memry/desktop test:main -- diagnostics-handlers.test.ts`.
- [ ] **Step 5: Commit.** `git commit -am "feat(desktop): diagnostics IPC handlers (preview/send incident report)"`

### Task 5.4: Renderer — consent + preview dialog

**Files:**

- Create: `apps/desktop/src/renderer/src/components/diagnostics/report-incident-dialog.tsx` (Radix `Dialog`, mirror `note/export-dialog.tsx`)
- Create: `apps/desktop/src/renderer/src/services/diagnostics-service.ts` (`createWindowApiForwarder(() => window.api.diagnostics)`)
- Create: `apps/desktop/src/renderer/src/hooks/use-incident-report.ts` (opens dialog with a trigger, calls `previewReport`, then `sendReport`, toasts the incident id)
- Test: `report-incident-dialog.test.tsx` (jsdom; Picker/dialog gotchas per repo notes)

**Interfaces:**

- Consumes `window.api.diagnostics.*` (5.2). Produces `useIncidentReport(): { open(trigger): void, dialog: ReactNode }` and the dialog component.

- [ ] **Step 1: Failing test** — render the dialog with a stubbed service returning a fixed `DiagnosticReport`; assert (a) it shows the redacted line count + a scrollable preview of exactly `report.lines`/`snapshot`, (b) clicking **Send** calls `sendReport` and shows the incident id, (c) **Not now** closes without calling `sendReport`, (d) **Preview** expands the raw redacted JSON. Use `useT('settings')` keys (added in 5.6).
- [ ] **Step 2–3: Implement.** Dialog states: closed → building (spinner while `previewReport`) → preview (Preview/Send/Not now) → sent (show `MEMRY-XXXX`). The preview renders `report` verbatim (preview IS the payload). Send disabled while in-flight — fire from `onPointerDown` per the repo submit-button gotcha.
- [ ] **Step 4: Run.** `pnpm --filter @memry/desktop test:renderer -- report-incident-dialog`.
- [ ] **Step 5: Commit.** `git commit -am "feat(desktop): incident-report consent + preview dialog"`

### Task 5.5: Renderer surfaces — error boundary CTA, toast action, settings entry

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tabs/tab-error-boundary.tsx` (add a "Send diagnostic report" CTA next to "Try again"; thread an `onReport` callback through the functional wrapper — hooks can't live in the class)
- Modify: `apps/desktop/src/renderer/src/App.tsx` (mount `useIncidentReport().dialog`; pass `open` into the boundary)
- Modify: `apps/desktop/src/renderer/src/pages/settings/general-section.tsx` (add a `SettingRowTall` in the Privacy group, ~line 445, with a Button → `open({ source: 'settings' })`, gated on `telemetryEnabled`)
- Optional: an IPC-error toast helper that adds `action: { label: t('…'), onClick: () => open({ source, errorCode }) }`
- Test: extend `tab-error-boundary` test + a settings test

**Interfaces:** consumes `useIncidentReport` (5.4). No new IPC.

- [ ] **Step 1–4: TDD.** Test the boundary renders the CTA and calls `onReport(error)` on click; test the settings row is disabled when telemetry is off and calls `open` when on. Implement. Run `pnpm --filter @memry/desktop test:renderer`.
- [ ] **Step 5: Commit.** `git commit -am "feat(desktop): surface incident-report CTA in error boundary, toasts, settings"`

### Task 5.6: i18n strings

**Files:**

- Modify: `packages/i18n/src/locales/en/settings.json` (consent dialog + settings copy under `general.privacy.diagnostics.*`; update `general.privacy.telemetry.description` to state diagnostic logs are included)
- Modify: `packages/i18n/src/locales/en/common.json` if any generic labels are needed

- [ ] **Step 1:** Add keys used in 5.4/5.5 (title, body, preview/send/notNow labels, sent-confirmation with `{incidentId}` interpolation, settings row label/description/button).
- [ ] **Step 2:** `pnpm --filter @memry/desktop i18n:check` → 0 missing/TODO.
- [ ] **Step 3: Commit.** `git commit -am "i18n(desktop): diagnostic report + settings privacy copy"`

---

## Phase 6 — Settings gate, docs, E2E, rollout

### Task 6.1: E2E — force error → preview → consent → mock POST; opted-out sends nothing

**Files:**

- Create: `apps/desktop/e2e/diagnostics-report.spec.ts` (Playwright + Electron; follow existing E2E harness — `seedNote`/`openNoteByHandle` patterns, `CI=1` `--disable-gpu`, 90s vault-open wait per repo E2E notes)

- [ ] **Step 1–2:** With a mock `/telemetry/logs` + `/diagnostics/report` endpoint (point `SYNC_SERVER_URL`/`TELEMETRY_ENDPOINT` at a local stub): (a) trigger a tab error → CTA appears → click → preview shows redacted lines → Send → assert the stub received a `DiagnosticReport` whose serialized body contains **no** injected synthetic secret; (b) with telemetry disabled, assert Path A posts nothing to `/telemetry/logs` and the report path is unavailable/sends nothing.
- [ ] **Step 3: Run.** `CI=1 pnpm --filter @memry/desktop test:e2e -- diagnostics-report.spec.ts`.
- [ ] **Step 4: Commit.** `git commit -am "test(desktop): e2e diagnostic report consent + opted-out no-send"`

### Task 6.2: Docs

**Files:**

- Modify: `apps/docs/src/architecture/observability.md` (in `## Error Logs in Grafana (Loki)`: new `kind=log` / `kind=report` subsections + the two endpoints near `## Server Configuration`; cross-reference redaction guarantees to `### What Never Ships`)
- Modify the privacy doc (find under `apps/docs/src/**`; state Path A always-on redacted logs + Path B opt-in report + the redaction contract)

- [ ] **Step 1:** Write the docs. Include the Grafana queries: `{app="desktop", kind="log"} | json`, `{app="desktop", kind="report"} | json | incident_id="MEMRY-…"`.
- [ ] **Step 2:** `pnpm docs:impact --base <base_commit> --strict` → `covered`; `pnpm docs:build` green.
- [ ] **Step 3: Commit.** `git commit -am "docs(observability): kind=log/report Loki streams + diagnostic endpoints"`

### Task 6.3: Rollout gate — desktop channel gate + kill switch verification

- [ ] **Step 1:** Confirm the desktop transport ships only when `buildChannel ∈ {staging, production}` AND telemetry enabled AND the endpoint resolves (dev = ring-buffer only, no ship). Confirm the server kill switch: with `LOKI_URL` unset the endpoints return 202 but push nothing (dev no-op), and disabling the endpoint (or unsetting Loki) stops all ingest without a desktop release.
- [ ] **Step 2:** Full gate: `pnpm lint && pnpm typecheck && pnpm test && pnpm ipc:check && pnpm --filter @memry/desktop i18n:check && pnpm docs:impact --base <base_commit> --strict && pnpm docs:build && git diff --check`.
- [ ] **Step 3:** Manual Grafana verification against production (Path A already deployed in Phase 2): run a staging/production desktop build, force one of the three known lines, confirm it appears in `/d/memry-logs` with `kind=log`, correct `env`/`level`, redacted `message`, and that a synthetic secret injected into the line does **NOT** appear in Loki.
- [ ] **Step 4:** `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`.

---

## Self-Review (spec coverage)

- Redaction core + fuzz invariant → Tasks 1.1–1.3. ✅ (crypto-free via injected hasher — resolves Worker portability the spec's literal `hashId` API didn't address).
- Contracts wire schemas → 2.1. Loki `kind` + mappers → 2.2. Endpoints + server PII guard (mask-mode re-redaction) → 2.2/2.3. Deploy-first → 2.4. ✅
- Per-install salt → 3.1. ✅
- Path A transport (reuse client semantics via parallel queue) + gating + throttle + ring buffer → 4.1–4.3. Worker forwarding (decision 6) → 4.4. `pull_page_dropped` → 4.5. ✅
- Path B assembler + preview-equals-payload + IPC + handlers + dialog + surfaces + i18n → 5.1–5.6. ✅
- Settings copy → 5.6. Docs → 6.2. E2E → 6.1. Rollout/kill-switch → 6.3. ✅
- Three known failure modes: ship unchanged via the transport (no code change) + validated in 1.3 fuzz + 6.3 Grafana check. ✅
- Non-regression of `/batch`: untouched; only additive `kind:'error'` label (2.2). ✅

**Type consistency check:** `redactLogLine`/`redactText`/`RedactOptions` (1.1–1.2) used identically in 2.2, 3.1, 4.2, 5.1. `DiagnosticLogLine`/`DiagnosticLogBatch`/`DiagnosticReport`/`DiagnosticSnapshot` (2.1) used in 2.2, 2.3, 4.2, 5.1, 5.3. `createShipQueue` (4.1) used in 4.2. `installLogShip`/`ingestForwarded`/`recentLines` (4.2) used in 4.3, 4.4, 5.1. `DiagnosticsChannels`/`window.api.diagnostics` (5.2) used in 5.3, 5.4. Consistent.

**Note on `import { redactLogLine, type DiagnosticLogLine }`:** `redactLogLine` lives in `@memry/contracts/redact`; `DiagnosticLogLine` lives in `@memry/contracts/diagnostics-api`. Split the imports accordingly (the inline comment in 4.2 flags this).
