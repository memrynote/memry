import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEEPSEEK_MODEL,
  type FakeDeepSeek,
  type FakeDeepSeekOptions,
  startFakeDeepSeek
} from '../src/main/agent/backends/__tests__/fixtures/deepseek-fake-server'

const KEY = 'fake-smoke-key-0123456789'
const appRoot = fileURLToPath(new URL('..', import.meta.url))

let server: FakeDeepSeek | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

async function smoke(options: FakeDeepSeekOptions = {}): Promise<{ code: number; output: string }> {
  server = await startFakeDeepSeek({ apiKey: KEY, ...options })
  const env = {
    ...process.env,
    MEMRY_SMOKE_BASE_URL: server.baseUrl,
    MEMRY_SMOKE_MODEL: DEEPSEEK_MODEL,
    MEMRY_SMOKE_API_KEY: KEY
  }
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'scripts/smoke-local-provider.ts'],
      { cwd: appRoot, env }
    )
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string }
    return { code: failed.code, output: failed.stdout + failed.stderr }
  }
}

describe('smoke-local-provider script against a fake DeepSeek server', () => {
  it('passes every check and never prints the key', async () => {
    const { code, output } = await smoke()

    expect(output).toMatch(/^PASS {2}probe: tools on, tool_choice omit$/m)
    expect(output).toMatch(/^PASS {2}tool round trip: tools called: vault_get_tags$/m)
    expect(output).toMatch(/^PASS {2}reasoning: /m)
    expect(output).toMatch(/^PASS {2}accepts reasoning_effort high$/m)
    expect(output).toMatch(/^PASS {2}accepts reasoning_effort max$/m)
    expect(output).toMatch(/^PASS {2}accepts thinking disabled$/m)
    expect(output).not.toMatch(/^FAIL/m)
    expect(output).not.toContain(KEY)
    expect(code).toBe(0)
    const sent = server!.requests.map((request) => request.body)
    expect(sent.some((body) => body.reasoning_effort === 'max')).toBe(true)
    expect(sent.some((body) => body.thinking?.type === 'disabled')).toBe(true)
  }, 60_000)

  it('fails the check for a field the API rejects and exits non-zero', async () => {
    const { code, output } = await smoke({ efforts: ['high'] })

    expect(output).toMatch(/^PASS {2}accepts reasoning_effort high$/m)
    expect(output).toMatch(
      /^FAIL {2}accepts reasoning_effort max: .*reasoning_effort max is not supported/m
    )
    expect(output).not.toContain(KEY)
    expect(code).toBe(1)
  }, 60_000)

  it('keeps the key out of error dumps when the provider echoes it back', async () => {
    const { code, output } = await smoke({ efforts: ['high'], echoAuth: true })

    expect(output).toMatch(/^FAIL {2}accepts reasoning_effort max: /m)
    expect(output).not.toContain(KEY)
    expect(code).toBe(1)
  }, 60_000)

  it('fails the probe and tool checks when the model cannot call tools', async () => {
    const { code, output } = await smoke({ tools: 'reject' })

    expect(output).toMatch(/^FAIL {2}probe: .*does not support function calling/m)
    expect(output).toMatch(/^FAIL {2}tool round trip: tools were turned off$/m)
    expect(code).toBe(1)
  }, 60_000)
})
