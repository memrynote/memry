import type { Page } from '@playwright/test'
import { dismissFirstRunOnboarding, waitForAppReady, waitForVaultReady } from './electron-helpers'

export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

export const PNG_BYTES = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0,
  0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 96, 0, 0, 0, 6, 0, 2, 48, 129,
  208, 47, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
]

/**
 * A minimal, valid single-page PDF with correct xref offsets, so pdf.js parses
 * it cleanly (onLoadSuccess → numPages 1) without shipping a binary fixture.
 * Content is pure ASCII, so byte length equals string length for the xref math.
 */
export function minimalPdfBytes(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] >>'
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((dict, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${dict}\nendobj\n`
  })
  const xrefOffset = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

export async function ready(page: Page): Promise<void> {
  await waitForAppReady(page)
  await waitForVaultReady(page)
  await dismissFirstRunOnboarding(page)
}

export function uniqueLabel(label: string): string {
  return `E2E ${label} ${Date.now()}`
}
