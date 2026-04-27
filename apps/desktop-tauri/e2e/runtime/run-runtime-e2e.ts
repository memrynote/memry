import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runtimeConfig } from './runtime.config'
import {
  assertRuntimeDriverSupported,
  buildRuntimeApp,
  runtimeDriverUnsupportedMessage,
  withRuntimeDriver,
  type RuntimeScenario
} from './helpers/driver'
import { withSeededVault } from './helpers/vault'

type RuntimeSpecModule = {
  scenarios?: RuntimeScenario[]
}

async function listSpecFiles(): Promise<string[]> {
  const specsDir = join(runtimeConfig.runtimeDir, 'specs')
  try {
    const entries = await readdir(specsDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
      .map((entry) => join(specsDir, entry.name))
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function loadScenarios(): Promise<RuntimeScenario[]> {
  const files = await listSpecFiles()
  const scenarios: RuntimeScenario[] = []

  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as RuntimeSpecModule
    scenarios.push(...(mod.scenarios ?? []))
  }

  return scenarios
}

async function main(): Promise<void> {
  const scenarios = await loadScenarios()

  if (process.argv.includes('--list')) {
    for (const scenario of scenarios) console.log(scenario.name)
    return
  }

  const unsupported = runtimeDriverUnsupportedMessage()
  if (unsupported) {
    console.log(`runtime:e2e skipped: ${unsupported}`)
    return
  }

  assertRuntimeDriverSupported()

  if (scenarios.length === 0) {
    throw new Error('No runtime e2e scenarios found under e2e/runtime/specs')
  }

  const appPath = await buildRuntimeApp()
  const failures: string[] = []

  for (const scenario of scenarios) {
    const started = Date.now()
    process.stdout.write(`runtime:e2e ${scenario.name} ... `)
    try {
      await withRuntimeDriver(
        {
          appPath,
          device: scenario.device ?? 'runtime',
          originTag: scenario.originTag ?? '9001'
        },
        async (session) => {
          await withSeededVault(session, async (vault) => {
            await scenario.run({ ...session, vault })
          })
        }
      )
      console.log(`ok (${Date.now() - started}ms)`)
    } catch (err) {
      const message = err instanceof Error ? err.stack || err.message : String(err)
      failures.push(`${scenario.name}\n${message}`)
      console.log('failed')
    }
  }

  if (failures.length > 0) {
    throw new Error(`Runtime e2e failures:\n\n${failures.join('\n\n')}`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
