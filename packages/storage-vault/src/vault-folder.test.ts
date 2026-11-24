import { afterEach, describe, expect, it } from 'vitest'
import { vaultFolderPath, windowsTrimsFolderName } from './vault-folder'

describe('vaultFolderPath', () => {
  it('reads a Windows-style path as the folder the rows name (#5642)', () => {
    expect(vaultFolderPath('a\\Supernotes')).toBe('a/Supernotes')
    expect(vaultFolderPath('a\\Supernotes\\')).toBe('a/Supernotes')
    expect(vaultFolderPath('C:\\Users\\me\\Notes')).toBeNull()
  })
})

describe('windowsTrimsFolderName', () => {
  const platform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('holds on Windows for a name ending in a dot or space, which Windows reads as another folder', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(['Supernotes.', 'a/Supernotes /b', 'a/Supernotes'].map(windowsTrimsFolderName)).toEqual([
      true,
      true,
      false
    ])
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(windowsTrimsFolderName('Supernotes.')).toBe(false)
  })
})
