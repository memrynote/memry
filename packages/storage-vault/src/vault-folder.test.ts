import { afterEach, describe, expect, it } from 'vitest'
import { vaultFolderPath } from './vault-folder'

describe('vaultFolderPath', () => {
  const platform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('reads a Windows-style path as the folder the rows name (#5642)', () => {
    expect(vaultFolderPath('a\\Supernotes')).toBe('a/Supernotes')
    expect(vaultFolderPath('a\\Supernotes\\')).toBe('a/Supernotes')
    expect(vaultFolderPath('C:\\Users\\me\\Notes')).toBeNull()
  })

  it('refuses on Windows a name ending in a dot or space, which Windows reads as another folder', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect([vaultFolderPath('Supernotes.'), vaultFolderPath('a/Supernotes /b')]).toEqual([
      null,
      null
    ])
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(vaultFolderPath('Supernotes.')).toBe('Supernotes.')
  })
})
