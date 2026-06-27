import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { runRaindropImport, type ApplyDeps } from './raindrop-importer'
import type { InboxItemPlan } from '@memry/importers/raindrop'
import type { ImportContext } from '../types'

const HEADER = 'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite'
const NOW = '2026-06-27T00:00:00.000Z'

function fakeCtx() {
  const c = { imported: 0, skipped: 0, failed: [] as string[] }
  const ctx: ImportContext = {
    status: () => {},
    setPhase: () => {},
    reportProgress: () => {},
    reportImported: () => {
      c.imported++
    },
    reportAttachment: () => {},
    reportSkipped: () => {
      c.skipped++
    },
    reportFailed: (item) => {
      c.failed.push(item)
    },
    isCancelled: () => false,
    signal: new AbortController().signal,
    toSummary: () => ({
      imported: c.imported,
      attachments: 0,
      skipped: c.skipped,
      failed: c.failed.map((item) => ({ item, error: '' }))
    })
  }
  return { ctx, c }
}

async function writeCsv(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'raindrop-'))
  const fp = join(dir, 'export.csv')
  await writeFile(fp, `${HEADER}\n${body}`, 'utf-8')
  return fp
}

describe('runRaindropImport', () => {
  it('saves one item per valid row and reports url-less rows as skipped', async () => {
    const fp = await writeCsv(
      [
        `1,A,,,https://a.com,Reading,,${NOW},,,false`,
        `2,B,,,https://b.com,Unsorted,,${NOW},,,false`,
        `3,no url,,,,Unsorted,,${NOW},,,false`
      ].join('\n')
    )
    const saved: InboxItemPlan[] = []
    const deps: ApplyDeps = { saveBookmark: (item) => saved.push(item) }
    const { ctx, c } = fakeCtx()

    await runRaindropImport([fp], deps, ctx, NOW)

    expect(saved.map((s) => s.sourceUrl)).toEqual(['https://a.com', 'https://b.com'])
    expect(c.imported).toBe(2)
    expect(c.skipped).toBe(1)
    expect(c.failed).toHaveLength(0)
  })

  it('isolates a per-row save failure without aborting the run', async () => {
    const fp = await writeCsv(
      [
        `1,A,,,https://a.com,Reading,,${NOW},,,false`,
        `2,B,,,https://b.com,Reading,,${NOW},,,false`
      ].join('\n')
    )
    const deps: ApplyDeps = {
      saveBookmark: (item) => {
        if (item.sourceUrl === 'https://a.com') throw new Error('db boom')
      }
    }
    const { ctx, c } = fakeCtx()

    await runRaindropImport([fp], deps, ctx, NOW)

    expect(c.imported).toBe(1)
    expect(c.failed).toEqual(['A'])
  })

  it('reports a malformed file as failed without throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raindrop-'))
    const fp = join(dir, 'bad.csv')
    await writeFile(fp, 'a,b,c\n1,2,3', 'utf-8')
    const deps: ApplyDeps = { saveBookmark: () => {} }
    const { ctx, c } = fakeCtx()

    await runRaindropImport([fp], deps, ctx, NOW)

    expect(c.imported).toBe(0)
    expect(c.failed).toHaveLength(1)
  })
})
