import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface TauriConfig {
  app?: { security?: { csp?: string } }
  plugins?: Record<string, unknown>
}

export interface Capability {
  identifier: string
  permissions: (string | { identifier: string })[]
}

export interface CapabilityCheckResult {
  missing: string[]
  pluginCount: number
  permissionCount: number
}

/**
 * Verifies that every plugin declared in tauri.conf.json has at least one
 * capability grant matching `{plugin}:*`. Missing grants present as silent
 * hangs at runtime (Spike 0 obs #11), so this script runs in CI to prevent
 * the class of bug where a plugin is configured but the renderer can never
 * invoke it.
 *
 * Over-granting (permissions for a plugin not in conf) is permitted — it does
 * not cause hangs and may be intentional for core:* grants.
 *
 * Pure function so it can be unit-tested without touching the filesystem.
 */
export function checkCapabilities(
  conf: TauriConfig,
  cap: Capability
): CapabilityCheckResult {
  const pluginsInConf = Object.keys(conf.plugins ?? {})
  const permissions = cap.permissions.map((p) =>
    typeof p === 'string' ? p : p.identifier
  )

  const missing: string[] = []
  for (const plugin of pluginsInConf) {
    const hasGrant = permissions.some((perm) => perm.startsWith(`${plugin}:`))
    if (!hasGrant) missing.push(plugin)
  }

  return {
    missing,
    pluginCount: pluginsInConf.length,
    permissionCount: permissions.length
  }
}

function runCli(): void {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  const conf = JSON.parse(
    readFileSync(resolve(appRoot, 'src-tauri/tauri.conf.json'), 'utf-8')
  ) as TauriConfig
  const cap = JSON.parse(
    readFileSync(resolve(appRoot, 'src-tauri/capabilities/default.json'), 'utf-8')
  ) as Capability

  const result = checkCapabilities(conf, cap)

  if (result.missing.length > 0) {
    process.stderr.write('❌ Capability sanity check failed.\n')
    process.stderr.write('Plugins without grants in capabilities/default.json:\n')
    for (const m of result.missing) process.stderr.write(`  - ${m}\n`)
    process.exit(1)
  }

  process.stdout.write(
    `✅ Capability sanity check passed (${result.pluginCount} plugins, ${result.permissionCount} grants)\n`
  )
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (invokedAsScript) {
  runCli()
}
