import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import dotenv from 'dotenv'

/**
 * Where the sync host being audited came from.
 *
 * `env-file` is the one that matters: a packaged build stages
 * `apps/desktop/.env.<MEMRY_ENV>` as `app-config` (see build-packaged-app.js),
 * and that file's `SYNC_SERVER_URL` is the host the shipped app dials. The gate
 * has to read the same file or it audits a host the build never contacts.
 */
export type CertCheckHostSource = 'process-env' | 'env-file' | 'default'

export interface CertCheckConfig {
  /** Sync server URL to derive the audited host from. Empty means "default host". */
  syncServerUrl: string
  strict: boolean
  hostSource: CertCheckHostSource
  /** Runtime env file consulted, relative to apps/desktop (e.g. `.env.production`). */
  envFile: string
  envFileFound: boolean
}

const DEFAULT_MEMRY_ENV = 'production'

/**
 * `prebuild` and `build:release` run the gate with no `MEMRY_ENV`, and both feed
 * a production package, so production is the right default.
 */
export function resolveRuntimeEnvFileName(env: NodeJS.ProcessEnv = process.env): string {
  return `.env.${env.MEMRY_ENV?.trim() || DEFAULT_MEMRY_ENV}`
}

export function resolveCertCheckConfig(
  appRoot: string,
  env: NodeJS.ProcessEnv = process.env
): CertCheckConfig {
  const envFile = resolveRuntimeEnvFileName(env)
  const envFilePath = join(appRoot, envFile)
  const envFileFound = existsSync(envFilePath)
  const fileEnv = envFileFound ? dotenv.parse(readFileSync(envFilePath, 'utf8')) : {}

  // An explicit ambient SYNC_SERVER_URL is a deliberate "audit this host instead"
  // and wins, matching dotenv's own no-override semantics. No build path sets it,
  // so in practice the env file decides.
  const ambientUrl = env.SYNC_SERVER_URL?.trim() ?? ''
  const fileUrl = fileEnv.SYNC_SERVER_URL?.trim() ?? ''
  const syncServerUrl = ambientUrl || fileUrl
  const hostSource: CertCheckHostSource = ambientUrl
    ? 'process-env'
    : fileUrl
      ? 'env-file'
      : 'default'

  // Strict is opt-in, not on by default: the production host still ships
  // placeholder pins, so forcing it would fail every prebuild (see #876). Reading
  // it from the runtime env file lets the environment that activates pinning for
  // a host turn the gate strict in the same file that names that host.
  const strictValue = env.MEMRY_CERT_PINS_STRICT ?? fileEnv.MEMRY_CERT_PINS_STRICT

  return {
    syncServerUrl,
    strict: strictValue === '1',
    hostSource,
    envFile,
    envFileFound
  }
}

export function describeCertCheckHost(config: CertCheckConfig, hostname: string): string {
  if (config.hostSource === 'process-env') {
    return `Auditing sync host ${hostname} from SYNC_SERVER_URL.`
  }

  if (config.hostSource === 'env-file') {
    return `Auditing sync host ${hostname} from apps/desktop/${config.envFile}.`
  }

  if (config.envFileFound) {
    return `apps/desktop/${config.envFile} sets no SYNC_SERVER_URL and none is exported — auditing the default sync host ${hostname}.`
  }

  return `No apps/desktop/${config.envFile} and no SYNC_SERVER_URL — auditing the default sync host ${hostname}. A packaged build stages ${config.envFile}, so run this where that file exists to audit the host the build ships against.`
}
