import { Miniflare } from 'miniflare'
import { SignJWT, exportPKCS8, exportSPKI, generateKeyPair } from 'jose'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { buildWorker } from '../scripts/build-worker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = path.resolve(__dirname, '../../../apps/sync-server/schema/d1.sql')

export interface ServerKeys {
  publicKeyPem: string
  privateKeyPem: string
  privateKey: CryptoKey
}

export class SimulatedServer {
  private mf: Miniflare | null = null
  private keys: ServerKeys | null = null

  async start(): Promise<void> {
    const workerPath = await buildWorker()

    this.keys = await this.generateJwtKeys()

    this.mf = new Miniflare({
      modules: true,
      scriptPath: workerPath,
      compatibilityDate: '2025-01-01',

      d1Databases: { DB: 'test-db' },
      r2Buckets: { STORAGE: 'test-bucket' },

      durableObjects: {
        USER_SYNC_STATE: 'UserSyncState',
        LINKING_SESSION: 'LinkingSession'
      },

      bindings: {
        ENVIRONMENT: 'development',
        JWT_PUBLIC_KEY: this.keys.publicKeyPem,
        JWT_PRIVATE_KEY: this.keys.privateKeyPem,
        RESEND_API_KEY: 'test-resend-key',
        OTP_HMAC_KEY: 'test-otp-hmac-key',
        RECOVERY_DUMMY_SECRET: 'test-recovery-secret',
        MIN_APP_VERSION: '0.1.0',
        ALLOWED_ORIGIN: 'http://localhost:3000'
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
      url = (input as Request).url
    }

    return this.mf.dispatchFetch(url, init)
  }

  async getD1(): Promise<D1Database> {
    if (!this.mf) throw new Error('Server not started')
    return this.mf.getD1Database('DB')
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
    const rawSchema = fs.readFileSync(SCHEMA_PATH, 'utf-8')

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
