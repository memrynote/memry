import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  describeCertCheckHost,
  resolveCertCheckConfig,
  resolveRuntimeEnvFileName
} from './check-cert-hashes-config.ts'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const gateScript = join(scriptsDir, 'check-cert-hashes.ts')

const stagedAppRoots: string[] = []

/** Stand-in for apps/desktop: only the runtime env file the gate must read. */
function stageAppRoot(envFileName: string, contents: string | null): string {
  const appRoot = mkdtempSync(join(tmpdir(), 'memry-cert-check-'))
  stagedAppRoots.push(appRoot)

  if (contents !== null) {
    writeFileSync(join(appRoot, envFileName), contents, 'utf8')
  }

  return appRoot
}

function runGate(appRoot: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--experimental-transform-types', gateScript, appRoot],
    {
      encoding: 'utf8',
      // Strip any ambient sync host so the run only reflects the staged env file.
      env: { ...process.env, SYNC_SERVER_URL: '', MEMRY_CERT_PINS_STRICT: '', MEMRY_ENV: '' }
    }
  )

  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

afterEach(() => {
  while (stagedAppRoots.length > 0) {
    rmSync(stagedAppRoots.pop() as string, { force: true, recursive: true })
  }
})

describe('resolveRuntimeEnvFileName', () => {
  it('defaults to the production env file, which is what prebuild/build:release stage', () => {
    expect(resolveRuntimeEnvFileName({})).toBe('.env.production')
    expect(resolveRuntimeEnvFileName({ MEMRY_ENV: '  ' })).toBe('.env.production')
  })

  it('follows MEMRY_ENV when the caller selects a different runtime env', () => {
    expect(resolveRuntimeEnvFileName({ MEMRY_ENV: 'staging' })).toBe('.env.staging')
  })
})

describe('resolveCertCheckConfig', () => {
  it('reads the sync host from the runtime env file the build stages', () => {
    const appRoot = stageAppRoot(
      '.env.production',
      'SYNC_SERVER_URL=https://sync-example.invalid\n'
    )

    const config = resolveCertCheckConfig(appRoot, {})

    expect(config.syncServerUrl).toBe('https://sync-example.invalid')
    expect(config.hostSource).toBe('env-file')
    expect(config.envFile).toBe('.env.production')
    expect(config.envFileFound).toBe(true)
  })

  it('reads the env file selected by MEMRY_ENV', () => {
    const appRoot = stageAppRoot(
      '.env.staging',
      'SYNC_SERVER_URL=https://sync-staging.memrynote.com\n'
    )

    const config = resolveCertCheckConfig(appRoot, { MEMRY_ENV: 'staging' })

    expect(config.syncServerUrl).toBe('https://sync-staging.memrynote.com')
    expect(config.hostSource).toBe('env-file')
  })

  it('lets an explicit ambient SYNC_SERVER_URL override the env file', () => {
    const appRoot = stageAppRoot(
      '.env.production',
      'SYNC_SERVER_URL=https://sync-example.invalid\n'
    )

    const config = resolveCertCheckConfig(appRoot, {
      SYNC_SERVER_URL: 'https://sync-staging.memrynote.com'
    })

    expect(config.syncServerUrl).toBe('https://sync-staging.memrynote.com')
    expect(config.hostSource).toBe('process-env')
  })

  it('falls back to the default host when no env file and no ambient url exist', () => {
    const appRoot = stageAppRoot('.env.production', null)

    const config = resolveCertCheckConfig(appRoot, {})

    expect(config.syncServerUrl).toBe('')
    expect(config.hostSource).toBe('default')
    expect(config.envFileFound).toBe(false)
    expect(describeCertCheckHost(config, 'sync.memrynote.com')).toContain(
      'No apps/desktop/.env.production'
    )
  })

  it('keeps strict off by default so placeholder pins never fail a build (#876)', () => {
    const appRoot = stageAppRoot(
      '.env.production',
      'SYNC_SERVER_URL=https://sync-example.invalid\n'
    )

    expect(resolveCertCheckConfig(appRoot, {}).strict).toBe(false)
  })

  it('turns strict on from the runtime env file that activates pinning for the host', () => {
    const appRoot = stageAppRoot(
      '.env.production',
      'SYNC_SERVER_URL=https://sync-example.invalid\nMEMRY_CERT_PINS_STRICT=1\n'
    )

    expect(resolveCertCheckConfig(appRoot, {}).strict).toBe(true)
  })

  it('lets an ambient MEMRY_CERT_PINS_STRICT override the env file', () => {
    const appRoot = stageAppRoot(
      '.env.production',
      'SYNC_SERVER_URL=https://sync-example.invalid\nMEMRY_CERT_PINS_STRICT=1\n'
    )

    expect(resolveCertCheckConfig(appRoot, { MEMRY_CERT_PINS_STRICT: '0' }).strict).toBe(false)
  })
})

describe('check-cert-hashes gate', () => {
  it('fails the build when the staged host has no pin entry', () => {
    const appRoot = stageAppRoot(
      '.env.production',
      'SYNC_SERVER_URL=https://sync-example.invalid\n'
    )

    const { status, stdout, stderr } = runGate(appRoot)

    expect(stdout).toContain('sync-example.invalid')
    expect(stderr).toContain('No certificate pins configured for sync host sync-example.invalid')
    expect(status).toBe(1)
  })

  it('audits the staged host rather than the default one when they differ', () => {
    const appRoot = stageAppRoot(
      '.env.production',
      'SYNC_SERVER_URL=https://sync-staging.memrynote.com\n'
    )

    const { status, stdout } = runGate(appRoot)

    expect(stdout).toContain('Certificate pins OK for sync-staging.memrynote.com')
    expect(stdout).not.toContain('sync.memrynote.com')
    expect(status).toBe(0)
  })

  it('still audits the default host, and says so, when no env file is staged', () => {
    const appRoot = stageAppRoot('.env.production', null)

    const { status, stdout } = runGate(appRoot)

    expect(stdout).toContain('auditing the default sync host sync.memrynote.com')
    expect(status).toBe(0)
  })
})
