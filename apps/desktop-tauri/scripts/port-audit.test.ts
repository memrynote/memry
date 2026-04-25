import { describe, it, expect } from 'vitest'
import { scanContent, isTestFile, countMemryRefs } from './port-audit'

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

  it('reports both ipcRenderer and electron-import hits on the same import line', () => {
    // #given
    const content = "import { ipcRenderer } from 'electron'"

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then both Electron-era patterns surface so neither slips through audit
    expect(hits).toHaveLength(2)
    expect(hits.map((h) => h.kind).sort()).toEqual(['electron-import', 'ipcRenderer'])
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

    // #then line 1 matches ipcRenderer + electron-import simultaneously
    expect(hits).toHaveLength(5)
    expect(hits.map((h) => h.kind)).toEqual([
      'ipcRenderer',
      'electron-import',
      'electron-toolkit',
      'window.api',
      'window.electron'
    ])
    expect(hits.map((h) => h.line)).toEqual([1, 1, 2, 3, 4])
  })

  it('ignores ipcRenderer substring that is not a whole word', () => {
    // #given
    const content = 'const myIpcRendererHelper = true // comment'

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits.filter((h) => h.kind === 'ipcRenderer')).toEqual([])
  })

  it('reports 1 electron-log hit on bare import', () => {
    // #given
    const content = "import log from 'electron-log/renderer'"

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('electron-log')
  })

  it('reports 1 electron-log hit on plain electron-log import', () => {
    // #given
    const content = "import log from 'electron-log'"

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('electron-log')
  })

  it('reports 1 electron-import hit for `from "electron"`', () => {
    // #given
    const content = "import { app } from 'electron'"

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('electron-import')
  })

  it('does not flag the Tauri-safe logger module name', () => {
    // #given
    const content = "import { createLogger } from '@/lib/logger'"

    // #when
    const hits = scanContent(content, 'fake.ts')

    // #then
    expect(hits).toEqual([])
  })
})

describe('countMemryRefs', () => {
  it('counts every @memry/ occurrence', () => {
    // #given
    const content = [
      "import type { Foo } from '@memry/contracts/notes-api'",
      "import { Bar } from '@memry/shared/utils'",
      'const x = 1'
    ].join('\n')

    // #when
    const total = countMemryRefs(content)

    // #then
    expect(total).toBe(2)
  })

  it('returns 0 for clean Tauri code', () => {
    // #given
    const content = "import { invoke } from '@/lib/ipc/invoke'"

    // #when
    const total = countMemryRefs(content)

    // #then
    expect(total).toBe(0)
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
