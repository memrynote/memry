import { describe, expect, it } from 'vitest'

import { parentProcessName, redactLaunchArgv } from './second-launch'

describe('redactLaunchArgv', () => {
  it('keeps what identifies the launcher and drops paths, flag values and deep-link queries', () => {
    expect(
      redactLaunchArgv([
        '/Applications/MemryNote.app/Contents/MacOS/MemryNote',
        '/Users/someone/app.asar/out/main/chunks/agy-mcp-bridge.js',
        '--user-data-dir=/Users/someone/profile',
        '--flag',
        'memry://oauth/callback?code=abc&state=xyz#frag'
      ])
    ).toEqual([
      'MemryNote',
      'agy-mcp-bridge.js',
      '--user-data-dir=<redacted>',
      '--flag',
      'memry://oauth/callback'
    ])
  })
})

describe('parentProcessName', () => {
  it.skipIf(process.platform === 'win32')('names a running process', () => {
    expect(parentProcessName(process.pid)).toBeTruthy()
  })

  it('returns undefined for a process that does not exist', () => {
    expect(parentProcessName(2 ** 22 + 12345)).toBeUndefined()
  })

  it('does not look up parents on Windows', () => {
    expect(parentProcessName(process.pid, 'win32')).toBeUndefined()
  })
})
