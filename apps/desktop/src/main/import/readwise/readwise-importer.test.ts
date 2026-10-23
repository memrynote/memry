import { describe, expect, it } from 'vitest'
import { readwiseImporter } from './readwise-importer'
import type { ImportContext } from '../types'

describe('readwiseImporter', () => {
  it('is an account-based importer on every plan', () => {
    expect(readwiseImporter).toMatchObject({ id: 'readwise', accountBased: true })
  })

  it('refuses to run until the import engine ships', async () => {
    await expect(readwiseImporter.run({ sourcePaths: [] }, {} as ImportContext)).rejects.toThrow(
      /not available in this build/
    )
  })
})
