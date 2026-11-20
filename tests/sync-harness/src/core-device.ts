import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SimulatedServer } from './simulated-server.js'
import type { DeviceIdentity } from './types.js'
import type { LocalVaultState } from './zero-loss-oracle/index.js'

/**
 * A fresh Rust core device: the `memry` CLI (`crates/memry-cli`) running
 * `Vault::first_sync` over its native transport against the harness Worker
 * (#5232). The CLI reaches the Worker through a local proxy, which does three
 * things the Worker cannot:
 *
 * - serves presigned pack downloads. The Worker signs them for `R2_ORIGIN`,
 *   which resolves nowhere; the proxy rewrites that origin in every JSON
 *   response to its own `/__r2/` route and answers from the Miniflare bucket.
 * - counts each request by path, for the kill points and the request totals.
 * - kills the process: at the n-th request of a path it sends SIGKILL and drops
 *   the request unanswered, so the run dies mid-phase like an app the OS ends.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const BINARY = process.env.MEMRY_CLI_BIN ?? path.join(ROOT, 'crates/target/debug/memry')
/** A run that outlives this is hung: it is killed and the test fails. */
const RUN_DEADLINE_MS = 90_000

/** The origin the Worker presigns packs for (its `R2_S3_ENDPOINT` binding). */
export const R2_ORIGIN = 'https://r2.local'
export const R2_BUCKET = 'harness-packs'

/** The Worker bindings that make it list packs with presigned URLs. */
export const R2_PRESIGN_BINDINGS = {
  R2_ACCESS_KEY_ID: 'harness-access-key',
  R2_SECRET_ACCESS_KEY: 'placeholder-harness-secret',
  R2_S3_ENDPOINT: R2_ORIGIN,
  R2_S3_BUCKET: R2_BUCKET
}

/** What `memry bench oracle-state` prints. */
export interface CoreOracleState extends LocalVaultState {
  /** Each live record's stored payload, as JSON text. */
  payloads: Record<string, string>
  /** Each body's merged Yjs state vector, in hex. */
  stateVectors: Record<string, string>
  /** Documents the device still owes a body pull. */
  owed: string[]
}

export interface KillPoint {
  /** A path prefix; `/__r2/` is a pack download. */
  path: string
  /** Die at the n-th request whose path starts with `path`, counted from the run's start. */
  n: number
}

export interface CoreRun {
  killed: boolean
  /** Request paths of this run, in arrival order. */
  requests: string[]
  /** The JSON marks the run printed. */
  marks: Array<Record<string, unknown>>
}

export class CoreDevice {
  private readonly home = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-core-device-'))
  private proxy: http.Server | null = null
  private origin = ''
  private run: { requests: string[]; killAt: KillPoint | null; kill: () => void } | null = null

  constructor(
    private readonly server: SimulatedServer,
    private readonly identity: DeviceIdentity,
    private readonly masterKey: Uint8Array,
    readonly vaultId = 'default'
  ) {}

  async start(): Promise<void> {
    if (!fs.existsSync(BINARY)) {
      throw new Error(`${BINARY} is missing: run pnpm --filter @memry/sync-harness build:core`)
    }
    const bucket = await this.server.getR2Bucket()
    this.proxy = http.createServer((req, res) => {
      this.handle(bucket, req, res).catch((error: unknown) => {
        res.statusCode = 502
        res.end(String(error))
      })
    })
    await new Promise<void>((resolve) => this.proxy!.listen(0, '127.0.0.1', resolve))
    const { port } = this.proxy.address() as AddressInfo
    this.origin = `http://127.0.0.1:${port}`

    // The CLI's file-backed secure store (`crates/memry-cli/src/session.rs`),
    // under the profile the CLI derives from the server URL.
    const secrets = path.join(this.home, '.memry-cli', `127-0-0-1-${port}`, 'secrets')
    fs.mkdirSync(secrets, { recursive: true, mode: 0o700 })
    const write = (name: string, value: Uint8Array | string) =>
      fs.writeFileSync(path.join(secrets, name), value, { mode: 0o600 })
    write('master-key', this.masterKey)
    write('device-signing-key', this.identity.signingSecretKey)
    write('access-token', this.identity.accessToken)
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.proxy ? this.proxy.close(() => resolve()) : resolve()
    )
    fs.rmSync(this.home, { recursive: true, force: true })
  }

  /** A first sync and its body passes; `resume` keeps what a killed run left. */
  async bootstrap(options: { resume?: boolean; killAt?: KillPoint } = {}): Promise<CoreRun> {
    const args = ['bench', 'bootstrap', '--vault', this.vaultId]
    if (options.resume) args.push('--resume')
    const requests: string[] = []
    const { code, signal, stdout, stderr } = await this.exec(args, (kill) => {
      this.run = { requests, killAt: options.killAt ?? null, kill }
    })
    this.run = null
    const killed = signal === 'SIGKILL'
    if (!killed && code !== 0) throw new Error(`memry bench bootstrap failed (${code}): ${stderr}`)
    if (options.killAt && !killed) {
      throw new Error(`kill point ${JSON.stringify(options.killAt)} was never reached`)
    }
    const marks = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    return { killed, requests, marks }
  }

  async oracleState(): Promise<CoreOracleState> {
    const { code, stdout, stderr } = await this.exec([
      'bench',
      'oracle-state',
      '--vault',
      this.vaultId
    ])
    if (code !== 0) throw new Error(`memry bench oracle-state failed (${code}): ${stderr}`)
    return JSON.parse(stdout) as CoreOracleState
  }

  private exec(
    args: string[],
    onSpawn?: (kill: () => void) => void
  ): Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
  }> {
    const child = spawn(BINARY, ['--server', this.origin, ...args], {
      env: { ...process.env, HOME: this.home, RUST_LOG: process.env.RUST_LOG ?? 'warn' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    onSpawn?.(() => child.kill('SIGKILL'))
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    let hung = false
    const deadline = setTimeout(() => {
      hung = true
      child.kill('SIGKILL')
    }, RUN_DEADLINE_MS)
    return new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code, signal) => {
        clearTimeout(deadline)
        if (hung)
          reject(new Error(`memry ${args.join(' ')} hung past ${RUN_DEADLINE_MS} ms: ${stderr}`))
        else resolve({ code, signal, stdout, stderr })
      })
    })
  }

  private async handle(
    bucket: R2Bucket,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    const run = this.run
    if (run) {
      run.requests.push(url.pathname)
      const killAt = run.killAt
      if (killAt && url.pathname.startsWith(killAt.path) && --killAt.n === 0) {
        run.killAt = null
        run.kill()
        req.socket.destroy()
        return
      }
    }

    if (url.pathname.startsWith('/__r2/')) {
      const key = url.pathname
        .slice(`/__r2/${R2_BUCKET}/`.length)
        .split('/')
        .map(decodeURIComponent)
        .join('/')
      const object = await bucket.get(key)
      if (!object) {
        res.statusCode = 404
        res.end()
        return
      }
      res.end(Buffer.from(await object.arrayBuffer()))
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value)
    }
    const response = await this.server.fetch(`http://localhost${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined
    })
    let body = Buffer.from(await response.arrayBuffer())
    const type = response.headers.get('content-type') ?? ''
    if (type.includes('json')) {
      body = Buffer.from(body.toString().replaceAll(`${R2_ORIGIN}/`, `${this.origin}/__r2/`))
    }
    res.statusCode = response.status
    response.headers.forEach((value, name) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(name)) {
        res.setHeader(name, value)
      }
    })
    res.end(body)
  }
}
