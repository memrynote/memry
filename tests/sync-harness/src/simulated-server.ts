import { Miniflare } from 'miniflare'
import { SignJWT, exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { buildWorker } from '../scripts/build-worker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
// Canonical schema = the ordered D1 migrations wrangler applies on deploy.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../apps/sync-server/migrations')
const BACKFILL_QUEUE = 'memry-pack-backfill-dev'
/** Past the backfill's 10 s hop delay (`pack-backfill.ts`), so a chain's next message runs. */
const BACKFILL_RETICK_MS = 12_000
const BACKFILL_SETTLE_DEADLINE_MS = 120_000
/**
 * The backfill's limits, copied because Playwright loads this file as CJS and
 * cannot import the Worker's ESM sources. `tests/backfill-limits.test.ts`
 * holds each equal to its source.
 */
export const BACKFILL_LIMITS = {
  /** `PACK_MIN_FILL_ROWS` (`pack-sizing.ts`). */
  minFillRows: 256,
  /** `PACK_SETTLE_SECONDS` (`pack-sizing.ts`). */
  settleSeconds: 24 * 60 * 60,
  /** `PACK_LIST_MAX_PACKS_PER_VAULT` (`@memry/contracts/sync-api`). */
  maxPacksPerVault: 999,
  /** `REWRITE_PENDING` (`pack-replaced-objects.ts`). */
  rewritePending: 'rewrite'
} as const

/**
 * Each packed kind's rows, sort column and write-time column, as the
 * backfill's backlog query reads them (`findBacklogVaults`, `pack-backfill.ts`).
 */
const BACKLOG_SOURCES = [
  { kind: 'record', table: 'sync_items', sort: 'server_cursor', time: 'updated_at' },
  { kind: 'crdt_snapshot', table: 'crdt_snapshots', sort: 'created_at', time: 'created_at' },
  { kind: 'crdt_update', table: 'crdt_updates', sort: 'server_cursor', time: 'created_at' }
] as const

export interface ServerKeys {
  publicKeyPem: string
  privateKeyPem: string
  privateKey: CryptoKey
}

export class SimulatedServer {
  private mf: Miniflare | null = null
  private keys: ServerKeys | null = null

  /** `bindings` add to or override the Worker's, such as R2 presign credentials. */
  async start(options: { bindings?: Record<string, string> } = {}): Promise<void> {
    const workerPath = await buildWorker()

    this.keys = await this.generateJwtKeys()

    this.mf = new Miniflare({
      rootPath: ROOT,
      modulesRoot: ROOT,
      modules: true,
      scriptPath: workerPath,
      compatibilityDate: '2025-01-01',

      // Ephemeral port. Miniflare defaults to 8787, which collides as soon as
      // two harness instances run side by side (Playwright workers > 1, or a
      // local `dev:sync-server`). Consumers read the real URL from getDirectUrl().
      port: 0,

      d1Databases: { DB: 'test-db' },
      r2Buckets: { STORAGE: 'test-bucket' },

      // The cron's pack backfill (#5278) enqueues here and this Worker's queue
      // handler consumes, as in wrangler.toml. Push nudges (PACK_QUEUE) stay
      // unbound, so packs are built only when a test runs the cron.
      queueProducers: { PACK_BACKFILL_QUEUE: { queueName: BACKFILL_QUEUE } },
      queueConsumers: { [BACKFILL_QUEUE]: { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 3 } },

      durableObjects: {
        USER_SYNC_STATE: 'UserSyncState',
        LINKING_SESSION: 'LinkingSession',
        // Rate limiting moved off D1 onto this DO (#1838) and the middleware
        // has no fail-open path: an absent binding throws and blocks every
        // rate-limited route. Miniflare must bind it or the whole E2E sync
        // surface answers 500.
        RATE_LIMITER: 'RateLimiter'
      },

      bindings: {
        ENVIRONMENT: 'development',
        JWT_PUBLIC_KEY: this.keys.publicKeyPem,
        JWT_PRIVATE_KEY: this.keys.privateKeyPem,
        RESEND_API_KEY: 'test-resend-key',
        OTP_HMAC_KEY: 'test-otp-hmac-key',
        RECOVERY_DUMMY_SECRET: 'test-recovery-secret',
        // Electron E2E launches out/main/index.js with no package.json beside
        // it, so app.getVersion() falls back to the executable's version: the
        // bundle version on macOS, "0.0" on Linux CI. A 0.1.0 floor refused
        // every Linux E2E socket with 426 and the realtime path went untested.
        MIN_APP_VERSION: '0.0.0',
        ALLOWED_ORIGIN: 'http://localhost:3000',
        ...options.bindings
      }
    })

    await this.runD1Migrations()
  }

  async stop(): Promise<void> {
    if (this.mf) {
      await this.mf.dispose()
      this.mf = null
    }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (!this.mf) throw new Error('Server not started')

    let url: string
    if (typeof input === 'string') {
      url = input.startsWith('http') ? input : `http://localhost${input}`
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }

    return this.mf.dispatchFetch(url, init)
  }

  /**
   * Run the Worker's scheduled handler. Since #5278 its pack backfill only
   * enqueues: the bound backfill queue's consumer builds the packs after this
   * returns, so a caller that needs them waits for `pack_index` to settle.
   */
  async triggerScheduled(cron = '0 */6 * * *'): Promise<void> {
    if (!this.mf) throw new Error('Server not started')
    const worker = await this.mf.getWorker()
    await worker.scheduled({ cron })
  }

  /**
   * Runs the cron until no vault holds a kind's rows the backfill would pack:
   * rows above its watermark that pass `packFillReady` (`pack-sizing.ts`) in a
   * vault below the listing cap, or a purge rewrite still pending
   * (`BACKFILL_LIMITS.rewritePending`).
   * A build lists its pack and moves the watermark in one D1 batch, so an empty
   * backlog means `pack_index` is final. Young rows below the fill stay unpacked.
   */
  async settlePackBackfill(): Promise<void> {
    const deadline = Date.now() + BACKFILL_SETTLE_DEADLINE_MS
    let retick = 0
    while (await this.packBacklog()) {
      if (Date.now() > deadline) throw new Error('the pack backfill never settled')
      if (Date.now() >= retick) {
        await this.triggerScheduled()
        retick = Date.now() + BACKFILL_RETICK_MS
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  private async packBacklog(): Promise<boolean> {
    const db = await this.getD1()
    const rewrite = await db
      .prepare('SELECT 1 FROM pack_replaced_objects WHERE replaced_by = ? LIMIT 1')
      .bind(BACKFILL_LIMITS.rewritePending)
      .first()
    if (rewrite) return true
    const settledBefore = Math.floor(Date.now() / 1000) - BACKFILL_LIMITS.settleSeconds
    for (const { kind, table, sort, time } of BACKLOG_SOURCES) {
      const ready = await db
        .prepare(
          `SELECT 1 FROM ${table} si
           LEFT JOIN pack_watermarks w
             ON w.user_id = si.user_id AND w.vault_id = si.vault_id AND w.item_kind = ?
           WHERE si.${sort} IS NOT NULL AND (w.user_id IS NULL OR si.${sort} > w.last_sort_value)
           GROUP BY si.user_id, si.vault_id
           HAVING (SELECT COUNT(*) FROM pack_index p
                   WHERE p.user_id = si.user_id AND p.vault_id = si.vault_id) < ?
             AND (COUNT(*) >= ? OR MIN(si.${time}) <= ?)
           LIMIT 1`
        )
        .bind(kind, BACKFILL_LIMITS.maxPacksPerVault, BACKFILL_LIMITS.minFillRows, settledBefore)
        .first()
      if (ready) return true
    }
    return false
  }

  async getD1(): Promise<D1Database> {
    if (!this.mf) throw new Error('Server not started')
    return this.mf.getD1Database('DB')
  }

  async getR2Bucket(): Promise<R2Bucket> {
    if (!this.mf) throw new Error('Server not started')
    return this.mf.getR2Bucket('STORAGE')
  }

  async getDirectUrl(): Promise<URL> {
    if (!this.mf) throw new Error('Server not started')
    return this.mf.ready
  }

  getKeys(): ServerKeys {
    if (!this.keys) throw new Error('Server not started')
    return this.keys
  }

  async createAccessToken(userId: string, deviceId: string): Promise<string> {
    if (!this.keys) throw new Error('Server not started')

    return new SignJWT({
      sub: userId,
      device_id: deviceId,
      type: 'access'
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('memry-sync')
      .setAudience('memry-client')
      .setExpirationTime('1h')
      .sign(this.keys.privateKey)
  }

  async truncateTables(): Promise<void> {
    const db = await this.getD1()
    const tables = [
      'crdt_snapshots',
      'crdt_updates',
      'device_sync_state',
      'sync_items',
      'server_cursor_sequence',
      'refresh_tokens',
      'linking_sessions',
      'consumed_setup_tokens',
      'devices',
      'user_identities',
      'otp_codes',
      'rate_limits',
      'upload_sessions',
      'blob_chunks',
      'users'
    ]

    for (const table of tables) {
      await db.prepare(`DELETE FROM ${table}`).run()
    }
  }

  private async generateJwtKeys(): Promise<ServerKeys> {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true
    })

    const publicKeyPem = await exportSPKI(publicKey)
    const privateKeyPem = await exportPKCS8(privateKey)

    return { publicKeyPem, privateKeyPem, privateKey }
  }

  private async runD1Migrations(): Promise<void> {
    const db = await this.getD1()
    const rawSchema = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      // oxlint-disable-next-line unicorn/no-array-sort -- tsconfig target ES2022 has no Array#toSorted; the array is a fresh filter() result
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((file) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'))
      .join('\n')

    const cleaned = rawSchema
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')

    const statements = cleaned
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const stmt of statements) {
      await db.prepare(stmt).run()
    }
  }
}
