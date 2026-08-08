import { readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { spawnCodexTurn } from '../codex-spawn'
import { spawnClaudeTurn } from '../spawn'

// A child that never starts (binary removed after the version probe, EACCES,
// EAGAIN) emits 'error' and never 'exit'. Nothing here is mocked: the whole
// point is the real node:child_process failure mode.
const MISSING_BINARY = path.join(tmpdir(), 'memry-missing-cli-binary-1034')

const uncaught: Error[] = []
const recordUncaught = (error: Error): void => {
  uncaught.push(error)
}

beforeEach(() => {
  uncaught.length = 0
  process.on('uncaughtException', recordUncaught)
})

afterEach(() => {
  process.off('uncaughtException', recordUncaught)
})

async function settleUncaught(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
}

async function tempDirCount(prefix: string): Promise<number> {
  const entries = await readdir(tmpdir())
  return entries.filter((entry) => entry.startsWith(prefix)).length
}

describe('CLI spawn failure', () => {
  it('rejects spawnClaudeTurn with the real spawn reason instead of crashing main', async () => {
    await expect(
      spawnClaudeTurn({ binaryPath: MISSING_BINARY, effort: 'low', prompt: 'hi' })
    ).rejects.toThrow(`Claude CLI failed to start: spawn ${MISSING_BINARY} ENOENT`)

    await settleUncaught()
    expect(uncaught).toEqual([])
  })

  it('rejects spawnCodexTurn with the real spawn reason instead of crashing main', async () => {
    await expect(
      spawnCodexTurn({ binaryPath: MISSING_BINARY, reasoningEffort: 'low', prompt: 'hi' })
    ).rejects.toThrow(`Codex CLI failed to start: spawn ${MISSING_BINARY} ENOENT`)

    await settleUncaught()
    expect(uncaught).toEqual([])
  })

  it('removes the temp dir holding the MCP bearer token when the Claude spawn fails', async () => {
    const before = await tempDirCount('memry-claude-')

    await expect(
      spawnClaudeTurn({
        binaryPath: MISSING_BINARY,
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

    expect(await tempDirCount('memry-claude-')).toBe(before)
  })

  it('removes the temp dir when the Codex spawn fails', async () => {
    const before = await tempDirCount('memry-codex-')

    await expect(
      spawnCodexTurn({ binaryPath: MISSING_BINARY, reasoningEffort: 'low', prompt: 'hi' })
    ).rejects.toThrow(/Codex CLI failed to start/)

    expect(await tempDirCount('memry-codex-')).toBe(before)
  })

  it.skipIf(process.platform === 'win32')(
    'does not crash main when the CLI dies before reading the prompt (stdin EPIPE)',
    async () => {
      const dyingBinary = path.join(tmpdir(), `memry-dying-cli-${process.pid}`)
      await writeFile(dyingBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

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
      const sleeper = path.join(tmpdir(), `memry-sleeping-cli-${process.pid}`)
      await writeFile(sleeper, '#!/bin/sh\nsleep 5\n', { mode: 0o755 })

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
      const notExecutable = path.join(tmpdir(), `memry-not-executable-cli-${process.pid}`)
      await writeFile(notExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 })

      await expect(
        spawnClaudeTurn({ binaryPath: notExecutable, effort: 'low', prompt: 'hi' })
      ).rejects.toThrow(`Claude CLI failed to start: spawn ${notExecutable} EACCES`)

      await settleUncaught()
      expect(uncaught).toEqual([])
    }
  )
})
