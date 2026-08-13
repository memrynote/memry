import { describe, it, expect } from 'vitest'
import { mapFiles } from './map-files.ts'
import type { ScannedFile } from './types.ts'

function file(area: ScannedFile['area'], relPath: string): ScannedFile {
  return { area, relPath, absPath: `/src/${relPath}`, rootDir: '/src' }
}

describe('mapFiles', () => {
  it('routes a daily calendar file to a journal entry', () => {
    const plan = mapFiles([file('calendar', '20260812.txt')])
    expect(plan.journals).toEqual([
      { absPath: '/src/20260812.txt', rootDir: '/src', date: '2026-08-12' }
    ])
    expect(plan.notes).toEqual([])
  })

  it('routes weekly, monthly, quarterly and yearly files to NotePlan/Calendar notes', () => {
    const plan = mapFiles([
      file('calendar', '2026-W33.txt'),
      file('calendar', '2026-08.txt'),
      file('calendar', '2026-Q3.txt'),
      file('calendar', '2026.txt')
    ])
    expect(plan.journals).toEqual([])
    expect(plan.notes.map((n) => [n.title, n.vaultFolder])).toEqual([
      ['2026-W33', 'NotePlan/Calendar'],
      ['2026-08', 'NotePlan/Calendar'],
      ['2026-Q3', 'NotePlan/Calendar'],
      ['2026', 'NotePlan/Calendar']
    ])
  })

  it('skips a calendar file whose name is not a calendar period', () => {
    const plan = mapFiles([file('calendar', 'scratch.txt')])
    expect(plan.notes).toEqual([])
    expect(plan.journals).toEqual([])
    expect(plan.skipped).toEqual([
      { item: 'scratch.txt', reason: 'Not a NotePlan calendar filename' }
    ])
  })

  it('mirrors the Notes folder tree under NotePlan/', () => {
    const plan = mapFiles([
      file('notes', 'start-here.txt'),
      file('notes', '10 - Projects/project-sample-1.txt'),
      file('notes', '30 - Resources/Manual/templating.txt')
    ])
    expect(plan.notes.map((n) => [n.title, n.vaultFolder])).toEqual([
      ['start-here', 'NotePlan'],
      ['project-sample-1', 'NotePlan/10 - Projects'],
      ['templating', 'NotePlan/30 - Resources/Manual']
    ])
  })

  it('puts archived notes under NotePlan/Archive', () => {
    const plan = mapFiles([file('archive', 'old/done-project.txt')])
    expect(plan.notes.map((n) => [n.title, n.vaultFolder])).toEqual([
      ['done-project', 'NotePlan/Archive/old']
    ])
  })

  it('accepts .md as well as .txt and skips anything else', () => {
    const plan = mapFiles([file('notes', 'a.md'), file('notes', 'b.pdf')])
    expect(plan.notes.map((n) => n.title)).toEqual(['a'])
    expect(plan.skipped).toEqual([{ item: 'b.pdf', reason: 'Unsupported file type' }])
  })
})
