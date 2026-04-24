import { describe, it, expect } from 'vitest'
import { scanContent, isTestFile } from './port-audit'

describe('scanContent', () => {
  it('reports 1 window.api hit with correct line number', () => {
    // #given
    const content = 'const x = window.api.notes.create(input)'

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toEqual([
      {
        file: 'fake.ts',
        line: 1,
        text: 'const x = window.api.notes.create(input)',
        kind: 'window.api'
      }
    ])
  })

  it('reports 1 ipcRenderer hit', () => {
    // #given
    const content = "import { ipcRenderer } from 'electron'"

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('ipcRenderer')
    expect(hits[0].line).toBe(1)
  })

  it('reports 1 electron-toolkit hit', () => {
    // #given
    const content = "import { is } from '@electron-toolkit/utils'"

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('electron-toolkit')
  })

  it('reports 1 window.electron hit', () => {
    // #given
    const content = 'window.electron.something()'

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('window.electron')
  })

  it('reports 5 hits for 5 identical window.api lines (no dedup)', () => {
    // #given
    const line = 'window.api.notes.list()'
    const content = Array(5).fill(line).join('\n')

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toHaveLength(5)
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3, 4, 5])
    expect(hits.every((h) => h.kind === 'window.api')).toBe(true)
  })

  it('reports 0 hits for clean code', () => {
    // #given
    const content = [
      'import { invoke } from "@/lib/ipc/invoke"',
      'export function create(input: CreateInput) {',
      '  return invoke("notes_create", input)',
      '}'
    ].join('\n')

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toEqual([])
  })

  it('reports multiple hits of different kinds on different lines', () => {
    // #given
    const content = [
      "import { ipcRenderer } from 'electron'",
      "import { is } from '@electron-toolkit/utils'",
      'const x = window.api.notes.create(input)',
      'window.electron.reload()'
    ].join('\n')

    // #when
    const hits = scanContent(content, 'multi.ts')

    // #then
    expect(hits).toHaveLength(4)
    expect(hits.map((h) => h.kind)).toEqual([
      'ipcRenderer',
      'electron-toolkit',
      'window.api',
      'window.electron'
    ])
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3, 4])
  })

  it('ignores ipcRenderer substring that is not a whole word', () => {
    // #given
    const content = 'const myIpcRendererHelper = true // comment'

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits.filter((h) => h.kind === 'ipcRenderer')).toEqual([])
  })
})

describe('isTestFile', () => {
  it('matches .test.ts files', () => {
    expect(isTestFile('hooks/use-journal.test.ts')).toBe(true)
  })

  it('matches .test.tsx files', () => {
    expect(isTestFile('components/window-controls.test.tsx')).toBe(true)
  })

  it('does not match production .ts files', () => {
    expect(isTestFile('services/notes-service.ts')).toBe(false)
  })

  it('does not match production .tsx files', () => {
    expect(isTestFile('pages/settings/ai-section.tsx')).toBe(false)
  })
})
