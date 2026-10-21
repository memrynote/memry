import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({
  userData: '',
  version: '1.0.0',
  generate: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.userData,
    getVersion: () => mocks.version
  }
}))
vi.mock('@memry/cli/sandbox/generate', () => ({ generateSandboxAt: mocks.generate }))

import {
  ensureSandboxVault,
  getSandboxInfo,
  getSandboxPath,
  isSandboxPath,
  sandboxNeedsGeneration
} from './sandbox'
import { readVaultIcon } from './vault-icon'

describe('sandbox vault', () => {
  beforeEach(() => {
    mocks.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-sandbox-'))
    mocks.version = '1.0.0'
    mocks.generate.mockReset()
    mocks.generate.mockImplementation(async (target: string) => {
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.join(target, '.memry'), { recursive: true })
      fs.writeFileSync(path.join(target, '.memry', 'config.json'), '{}')
      return {}
    })
  })

  afterEach(() => {
    fs.rmSync(mocks.userData, { recursive: true, force: true })
  })

  it('lives in userData and is recognised by path only', () => {
    expect(getSandboxPath()).toBe(path.join(mocks.userData, 'Sandbox'))
    expect(isSandboxPath(getSandboxPath())).toBe(true)
    expect(isSandboxPath(path.join(mocks.userData, 'Other'))).toBe(false)
    expect(isSandboxPath(null)).toBe(false)
  })

  it('generates on first use with unpacked assets, and gives the vault its icon', async () => {
    expect(getSandboxInfo().exists).toBe(false)

    await ensureSandboxVault()

    expect(getSandboxInfo().exists).toBe(true)
    expect(mocks.generate).toHaveBeenCalledWith(
      getSandboxPath(),
      expect.any(Date),
      path.join(__dirname, 'sandbox-assets')
    )
    expect(readVaultIcon(getSandboxPath())?.value).toBe('icon:CodesandboxIcon')
  })

  it('leaves a current sandbox alone', async () => {
    await ensureSandboxVault()
    await ensureSandboxVault()
    expect(mocks.generate).toHaveBeenCalledTimes(1)
  })

  it('regenerates after an app update, and on reset', async () => {
    await ensureSandboxVault()

    mocks.version = '1.1.0'
    expect(sandboxNeedsGeneration()).toBe(true)
    await ensureSandboxVault()
    expect(mocks.generate).toHaveBeenCalledTimes(2)

    await ensureSandboxVault(true)
    expect(mocks.generate).toHaveBeenCalledTimes(3)
  })

  it('stays ungenerated, and retries, when generation fails', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('disk full'))
    await expect(ensureSandboxVault()).rejects.toThrow('disk full')
    expect(getSandboxInfo().exists).toBe(false)

    await ensureSandboxVault()
    expect(getSandboxInfo().exists).toBe(true)
  })
})
