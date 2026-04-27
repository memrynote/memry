import { mkdtemp, rm } from 'node:fs/promises'
import { runtimeConfig } from '../runtime.config'
import type { RuntimeDriverSession, SeededVault } from './driver'
import { invokeRuntimeCommand } from './devtools'

interface RuntimeVault {
  root: string
  seed: SeededVault
}

export async function withSeededVault<T>(
  session: RuntimeDriverSession,
  run: (vault: RuntimeVault) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(runtimeConfig.tmpRootPrefix)
  try {
    await invokeRuntimeCommand<void>(session.browser, 'devtools_reset_db')
    await invokeRuntimeCommand(session.browser, 'devtools_open_test_vault', { root })
    const seed = await invokeRuntimeCommand<SeededVault>(session.browser, 'devtools_seed_vault', {
      root
    })
    return await run({ root, seed })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
