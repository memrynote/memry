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
  missingAppManifestCommands: string[]
  missingAppPermissions: string[]
  pluginCount: number
  permissionCount: number
  registeredCommandCount: number
  appManifestCommandCount: number
}

export interface AppAclCommandSet {
  registeredCommands?: string[]
  manifestCommands?: string[]
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
  cap: Capability,
  appAcl: AppAclCommandSet = {}
): CapabilityCheckResult {
  const pluginsInConf = Object.keys(conf.plugins ?? {})
  const permissions = cap.permissions.map((p) =>
    typeof p === 'string' ? p : p.identifier
  )
  const registeredCommands = appAcl.registeredCommands ?? []
  const manifestCommands = appAcl.manifestCommands ?? []
  const manifestSet = new Set(manifestCommands)
  const permissionSet = new Set(permissions)

  const missing: string[] = []
  for (const plugin of pluginsInConf) {
    const hasGrant = permissions.some((perm) => perm.startsWith(`${plugin}:`))
    if (!hasGrant) missing.push(plugin)
  }

  const missingAppManifestCommands = registeredCommands.filter(
    (command) => !manifestSet.has(command)
  )
  const missingAppPermissions = registeredCommands.filter(
    (command) => !permissionSet.has(permissionForCommand(command))
  )

  return {
    missing,
    missingAppManifestCommands,
    missingAppPermissions,
    pluginCount: pluginsInConf.length,
    permissionCount: permissions.length,
    registeredCommandCount: registeredCommands.length,
    appManifestCommandCount: manifestCommands.length
  }
}

export function permissionForCommand(command: string): string {
  return `allow-${command.replaceAll('_', '-')}`
}

export function parseAppManifestCommands(source: string): string[] {
  const match = source.match(/AppManifest::new\(\)\.commands\(&\[(?<body>[\s\S]*?)\]\)/m)
  const body = match?.groups?.body
  if (!body) return []
  return Array.from(body.matchAll(/"([^"]+)"/g), (item) => item[1])
}

export function parseRegisteredAppCommands(source: string): string[] {
  const body = extractGenerateHandlerBody(source)
  if (!body) return []
  const withoutCfgCommands = body.replace(
    /#\[cfg\([^\]]*\)\]\s*commands::[A-Za-z0-9_:]+::[a-zA-Z0-9_]+\s*,?/g,
    ''
  )
  return Array.from(
    withoutCfgCommands.matchAll(/commands::[A-Za-z0-9_:]+::([a-zA-Z0-9_]+)/g),
    (item) => item[1]
  )
}

function extractGenerateHandlerBody(source: string): string | null {
  const marker = 'generate_handler!['
  const start = source.indexOf(marker)
  if (start === -1) return null
  const bodyStart = start + marker.length
  let depth = 1
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '[') {
      depth += 1
      continue
    }
    if (ch !== ']') continue
    depth -= 1
    if (depth === 0) return source.slice(bodyStart, i)
  }
  return null
}

function runCli(): void {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  const conf = JSON.parse(
    readFileSync(resolve(appRoot, 'src-tauri/tauri.conf.json'), 'utf-8')
  ) as TauriConfig
  const cap = JSON.parse(
    readFileSync(resolve(appRoot, 'src-tauri/capabilities/default.json'), 'utf-8')
  ) as Capability
  const buildRs = readFileSync(resolve(appRoot, 'src-tauri/build.rs'), 'utf-8')
  const libRs = readFileSync(resolve(appRoot, 'src-tauri/src/lib.rs'), 'utf-8')

  const result = checkCapabilities(conf, cap, {
    registeredCommands: parseRegisteredAppCommands(libRs),
    manifestCommands: parseAppManifestCommands(buildRs)
  })

  if (result.missing.length > 0) {
    process.stderr.write('❌ Capability sanity check failed.\n')
    process.stderr.write('Plugins without grants in capabilities/default.json:\n')
    for (const m of result.missing) process.stderr.write(`  - ${m}\n`)
    process.exit(1)
  }
  if (result.missingAppManifestCommands.length > 0) {
    process.stderr.write('❌ Capability sanity check failed.\n')
    process.stderr.write('Registered app commands missing from build.rs AppManifest:\n')
    for (const m of result.missingAppManifestCommands) process.stderr.write(`  - ${m}\n`)
    process.exit(1)
  }
  if (result.missingAppPermissions.length > 0) {
    process.stderr.write('❌ Capability sanity check failed.\n')
    process.stderr.write('Registered app commands missing allow-* grants in capabilities/default.json:\n')
    for (const m of result.missingAppPermissions) {
      process.stderr.write(`  - ${m} (${permissionForCommand(m)})\n`)
    }
    process.exit(1)
  }

  process.stdout.write(
    `✅ Capability sanity check passed (${result.pluginCount} plugins, ${result.permissionCount} grants, ${result.registeredCommandCount} app commands)\n`
  )
}

const invokedAsScript = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (invokedAsScript) {
  runCli()
}
