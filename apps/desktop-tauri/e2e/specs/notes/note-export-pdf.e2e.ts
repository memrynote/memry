// PDF export through the print window (Step 34, #3551): each page size Electron's `printToPDF`
// offered gives pages of that size, a note longer than a page gives several, a missing note
// answers `not_found` without a file, a note whose raw HTML reaches for the web prints with
// nothing fetched, opened or left behind, and a call naming its own `outputPath` is refused. The
// file is chosen through the save dialog, answered from the e2e dialog queue. Pixel fidelity
// against the Electron baselines is stage D.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { invokeTest } from '../../harness/invoke-test'
import { createNote, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import type { TauriApp } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'
import { invoke } from '../../harness/vault-commands'

/** `ExportNoteInput` of `commands/export.rs`. */
interface ExportInput {
  noteId: string
  includeMetadata?: boolean
  pageSize?: 'A4' | 'Letter' | 'Legal'
}

interface ExportResult {
  success: boolean
  path?: string
  code?: 'cancelled' | 'not_found' | 'failed'
  error?: string
}

const SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008]
} as const

const exportPdf = (page: Page, input: ExportInput) =>
  invoke<ExportResult>(page, 'notes_export_pdf', { input })

/** The export with the save dialog answering `out`. */
async function exportPdfTo(
  app: TauriApp,
  page: Page,
  input: ExportInput,
  out: string
): Promise<ExportResult> {
  await invokeTest(app, 'e2e_dialog_queue_push', { kind: 'SaveFile', paths: [out] })
  return exportPdf(page, input)
}

/** Every page's `/MediaBox` width and height, in points. */
function pageBoxes(pdf: Buffer): Array<[number, number]> {
  const boxes = pdf
    .toString('latin1')
    .matchAll(/\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/g)
  return [...boxes].map((m) => [Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])])
}

/** A note several pages long at any of the sizes. */
function longNote(): string {
  const para =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(
      5
    )
  const sections = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${para}`)
  return `# Long note\n\n\`\`\`js\nconst x = 1\n\`\`\`\n\n| A | B |\n|---|---|\n| one | two |\n\n${sections.join('\n\n')}\n\nThe last paragraph.\n`
}

test('each page size prints pages of that size', async ({ app, page }) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `PDF sizes ${Date.now()}`,
    content: longNote(),
    folder: 'notes'
  })
  const dir = mkdtempSync(join(tmpdir(), 'memry-export-pdf-'))
  try {
    for (const [size, [width, height]] of Object.entries(SIZES) as Array<
      [keyof typeof SIZES, readonly [number, number]]
    >) {
      const out = join(dir, `${size}.pdf`)
      const result = await exportPdfTo(app, page, { noteId: note.id, pageSize: size }, out)
      expect(result).toEqual({ success: true, path: out })
      const pdf = readFileSync(out)
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      const boxes = pageBoxes(pdf)
      expect(boxes.length).toBeGreaterThan(1)
      for (const [w, h] of boxes) {
        expect(Math.abs(w - width)).toBeLessThanOrEqual(1)
        expect(Math.abs(h - height)).toBeLessThanOrEqual(1)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing note answers not_found and writes nothing', async ({ page }) => {
  await vaultOpen(page)
  const dir = mkdtempSync(join(tmpdir(), 'memry-export-pdf-'))
  try {
    const out = join(dir, 'missing.pdf')
    // The note is looked up before the dialog opens, so no answer is queued.
    const result = await exportPdf(page, { noteId: 'no-such-note' })
    expect(result.success).toBe(false)
    expect(result.code).toBe('not_found')
    expect(existsSync(out)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a call carrying outputPath is refused and writes nothing', async ({ page }) => {
  await vaultOpen(page)
  const note = await createNote(page, {
    title: `PDF planted ${Date.now()}`,
    content: 'Body.',
    folder: 'notes'
  })
  const dir = mkdtempSync(join(tmpdir(), 'memry-export-pdf-'))
  try {
    const out = join(dir, 'planted.pdf')
    // Caught in the page: past `page.evaluate` the rejection is a HarnessError without the
    // command's text.
    const outcome = await page.evaluate(
      ([noteId, outputPath]: [string, string]) =>
        window.__TAURI__.core.invoke('notes_export_pdf', { input: { noteId, outputPath } }).then(
          () => 'resolved',
          (error: unknown) =>
            `rejected: ${typeof error === 'string' ? error : JSON.stringify(error)}`
        ),
      [note.id, out]
    )
    expect(outcome).toMatch(/^rejected: .*outputPath/)
    expect(existsSync(out)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A web site on this machine's LAN address (the app treats a loopback URL as its own), recording
 * every path it is asked for.
 */
async function startSite(): Promise<{ origin: string; hits: string[]; close(): Promise<void> }> {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address
  if (!address) throw new Error('no non-loopback IPv4 address to serve the fixture site from')
  const hits: string[] = []
  const server = createServer((request, response) => {
    hits.push(request.url ?? '/')
    response.writeHead(204).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://${address}:${port}`,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}

/** Raw HTML that would leave the page: a refresh, resource hints, a new-window link, a form, an image. */
const hostileNote = (origin: string): string =>
  [
    '# Hostile',
    '',
    `<meta http-equiv="refresh" content="0;url=${origin}/refresh">`,
    `<link rel="preconnect" href="${origin}">`,
    `<link rel="dns-prefetch" href="${origin}">`,
    `<link rel="prefetch" href="${origin}/prefetch">`,
    `<link rel="preload" as="image" href="${origin}/preload.png">`,
    '',
    `<a href="${origin}/blank" target="_blank">open</a>`,
    '',
    `<form action="${origin}/form"><input name="q" value="x"><button>go</button></form>`,
    '',
    `<img src="${origin}/remote.png" alt="remote">`,
    '',
    'The body prints.'
  ].join('\n')

test('a note whose raw HTML reaches for the web prints with nothing fetched or opened', async ({
  app,
  page
}) => {
  await vaultOpen(page)
  const site = await startSite()
  const dir = mkdtempSync(join(tmpdir(), 'memry-export-pdf-'))
  try {
    const note = await createNote(page, {
      title: `PDF hostile ${Date.now()}`,
      content: hostileNote(site.origin),
      folder: 'notes'
    })
    const out = join(dir, 'hostile.pdf')
    const result = await exportPdfTo(app, page, { noteId: note.id }, out)
    expect(result).toEqual({ success: true, path: out })
    expect(readFileSync(out).subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const labels = async () =>
      (await invokeTest<Array<{ label: string }>>(app, 'e2e_windows')).map((w) => w.label)
    await expect
      .poll(async () => (await labels()).filter((label) => label.startsWith('pdf-print-')), {
        timeout: 15_000
      })
      .toEqual([])
    // A refresh or a hint the window let through would have reached the site by now.
    await page.waitForTimeout(1_000)
    expect(site.hits).toEqual([])
    const opens = await invokeTest<string[]>(app, 'e2e_os_opens')
    expect(opens.filter((open) => open.includes(site.origin))).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await site.close()
  }
})
