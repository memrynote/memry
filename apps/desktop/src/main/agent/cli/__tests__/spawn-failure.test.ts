import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { spawnCodexTurn } from '../codex-spawn'
import { spawnClaudeTurn } from '../spawn'

// A child that never starts (binary removed after the version probe, EACCES,
// EAGAIN) emits 'error' and never 'exit'. Nothing here is mocked: the whole
// point is the real node:child_process failure mode.

// Every fixture binary lives inside a per-test mkdtemp directory, so no test
// ever creates a file at a predictable path in the OS temp dir.
let fixtureDir: string
let missingBinary: string

const uncaught: Error[] = []
const recordUncaught = (error: Error): void => {
  uncaught.push(error)
}

beforeEach(async () => {
  uncaught.length = 0
  process.on('uncaughtException', recordUncaught)
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'memry-spawn-failure-'))
  missingBinary = path.join(fixtureDir, 'claude')
})

afterEach(async () => {
  process.off('uncaughtException', recordUncaught)
  // afterEach still runs when the test body throws, so a failing test never
  // leaves the fixture directory behind.
  await rm(fixtureDir, { recursive: true, force: true })
})

async function settleUncaught(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

/**
 * Points os.tmpdir() at `root` for the duration of `run`, so the directory the
 * production code mkdtemps can be asserted on exactly instead of by scanning
 * the shared OS temp dir (which other test files write to in parallel).
 */
async function withTempRoot<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }
  process.env.TMPDIR = root
  process.env.TMP = root
  process.env.TEMP = root
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function writeFixtureBinary(name: string, body: string, mode: number): Promise<string> {
  const file = path.join(fixtureDir, name)
  await writeFile(file, body, { mode })
  return file
}

describe('CLI spawn failure', () => {
  it('rejects spawnClaudeTurn with the real spawn reason instead of crashing main', async () => {
    await expect(
      spawnClaudeTurn({ binaryPath: missingBinary, effort: 'low', prompt: 'hi' })
    ).rejects.toThrow(`Claude CLI failed to start: spawn ${missingBinary} ENOENT`)

    await settleUncaught()
    expect(uncaught).toEqual([])
  })

  it('rejects spawnCodexTurn with the real spawn reason instead of crashing main', async () => {
    await expect(
      spawnCodexTurn({ binaryPath: missingBinary, reasoningEffort: 'low', prompt: 'hi' })
    ).rejects.toThrow(`Codex CLI failed to start: spawn ${missingBinary} ENOENT`)

    await settleUncaught()
    expect(uncaught).toEqual([])
  })

  it('removes the temp dir holding the MCP bearer token when the Claude spawn fails', async () => {
    await withTempRoot(fixtureDir, async () => {
      await expect(
        spawnClaudeTurn({
          binaryPath: missingBinary,
          mcp: {
            serverUrl: 'http://127.0.0.1:54321',
            authorizationValue: 'secret-bearer-token',
            conversationId: 'conversation-1',
            windowId: 'window-1',
            allowedTools: 'mcp__memry__vault_read_note'
          },
          effort: 'low',
          prompt: 'hi'
        })
      ).rejects.toThrow(/Claude CLI failed to start/)
    })

    // missingBinary was never created, so the only thing that could be here is
    // the memry-claude-* directory the failed spawn left behind.
    expect(await readdir(fixtureDir)).toEqual([])
  })

  it('removes the temp dir when the Codex spawn fails', async () => {
    await withTempRoot(fixtureDir, async () => {
      await expect(
        spawnCodexTurn({ binaryPath: missingBinary, reasoningEffort: 'low', prompt: 'hi' })
      ).rejects.toThrow(/Codex CLI failed to start/)
    })

    expect(await readdir(fixtureDir)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'does not crash main when the CLI dies before reading the prompt (stdin EPIPE)',
    async () => {
      const dyingBinary = await writeFixtureBinary('dying-cli', '#!/bin/sh\nexit 0\n', 0o755)

      const sub = await spawnClaudeTurn({
        binaryPath: dyingBinary,
        effort: 'low',
        // Larger than the pipe buffer, so the write is still in flight when the
        // child is already gone.
        prompt: 'x'.repeat(8_000_000)
      })
      await new Promise((resolve) => sub.proc.once('close', resolve))
      await settleUncaught()

      expect(uncaught).toEqual([])
      await sub.cleanup()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not crash main when the child errors after it started (a failed kill)',
    async () => {
      const sleeper = await writeFixtureBinary('sleeping-cli', '#!/bin/sh\nsleep 5\n', 0o755)

      const sub = await spawnClaudeTurn({ binaryPath: sleeper, effort: 'low', prompt: 'hi' })
      // What node emits when subprocess.kill() fails — cancelTurn/killAll both
      // kill children, and the gate's own listener is long gone by then.
      sub.proc.emit('error', Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }))
      await settleUncaught()

      expect(uncaught).toEqual([])
      sub.proc.kill('SIGKILL')
      await sub.cleanup()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects when the binary exists but is not executable',
    async () => {
      const notExecutable = await writeFixtureBinary(
        'not-executable-cli',
        '#!/bin/sh\nexit 0\n',
        0o644
      )

      await expect(
        spawnClaudeTurn({ binaryPath: notExecutable, effort: 'low', prompt: 'hi' })
      ).rejects.toThrow(`Claude CLI failed to start: spawn ${notExecutable} EACCES`)

      await settleUncaught()
      expect(uncaught).toEqual([])
    }
  )
})
