import { describe, it, expect, vi } from 'vitest'
import { importFilesToProject, type ImportFilesToProjectDeps } from './import-files-to-project'

const file = (destPath: string): { destPath: string; filename: string; fileType: string } => ({
  destPath,
  filename: destPath.split('/').pop() ?? destPath,
  fileType: 'pdf'
})

const makeDeps = (overrides: Partial<ImportFilesToProjectDeps> = {}): ImportFilesToProjectDeps => ({
  importFiles: vi.fn(async () => ({ importedFiles: [file('notes/a.pdf')], errors: [] })),
  getIdByPath: vi.fn(async () => 'file-1'),
  linkToProject: vi.fn(),
  sleep: vi.fn(async () => {}),
  ...overrides
})

describe('importFilesToProject', () => {
  it('links each imported file once the indexer has assigned an id', async () => {
    const deps = makeDeps()

    const result = await importFilesToProject(deps, {
      projectId: 'p1',
      sourcePaths: ['/tmp/a.pdf']
    })

    expect(result).toEqual({ success: true, linked: ['file-1'], failed: [] })
    expect(deps.linkToProject).toHaveBeenCalledWith('p1', 'file-1')
  })

  it('waits for the indexer instead of giving up on the first miss', async () => {
    const getIdByPath = vi
      .fn<ImportFilesToProjectDeps['getIdByPath']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('file-1')
    const deps = makeDeps({ getIdByPath })

    const result = await importFilesToProject(deps, {
      projectId: 'p1',
      sourcePaths: ['/tmp/a.pdf']
    })

    expect(result.linked).toEqual(['file-1'])
    expect(getIdByPath).toHaveBeenCalledTimes(3)
  })

  it('reports a file that never gets indexed instead of hanging', async () => {
    const deps = makeDeps({ getIdByPath: vi.fn(async () => null) })

    const result = await importFilesToProject(deps, {
      projectId: 'p1',
      sourcePaths: ['/tmp/b.pdf']
    })

    expect(result.linked).toEqual([])
    expect(result.failed).toEqual([
      { path: 'notes/a.pdf', error: expect.stringMatching(/indexer/i) }
    ])
    expect(result.success).toBe(false)
  })

  it('links the files that resolved even when one of them did not', async () => {
    const deps = makeDeps({
      importFiles: vi.fn(async () => ({
        importedFiles: [file('notes/a.pdf'), file('notes/b.pdf')],
        errors: []
      })),
      getIdByPath: vi.fn(async (path: string) => (path === 'notes/a.pdf' ? 'file-a' : null))
    })

    const result = await importFilesToProject(deps, {
      projectId: 'p1',
      sourcePaths: ['/tmp/a.pdf', '/tmp/b.pdf']
    })

    expect(result.linked).toEqual(['file-a'])
    expect(result.failed).toHaveLength(1)
  })

  it('carries through errors reported by the importer itself', async () => {
    const deps = makeDeps({
      importFiles: vi.fn(async () => ({ importedFiles: [], errors: ['disk full'] }))
    })

    const result = await importFilesToProject(deps, { projectId: 'p1', sourcePaths: ['/tmp/a'] })

    expect(result.failed).toEqual([{ path: '', error: 'disk full' }])
    expect(result.linked).toEqual([])
  })
})
