#!/usr/bin/env node
/**
 * Writes `crates/memry-desktop/assets/pdf-badge.webp`, the thumbnail `ImageService` gives a PDF.
 *
 * It renders the SVG of Electron's `generatePdfPlaceholder`
 * (`apps/desktop/src/main/image-processing/operations.ts:162-184`) with Electron's own sharp, to
 * WebP at quality 80, as Electron does on every call. librsvg picks the host's sans-serif font,
 * so the bytes vary by machine; the size (160x200) and the look do not. Run it once and commit the
 * file; nothing checks it for staleness.
 *
 *   node apps/desktop-tauri/scripts/generate-pdf-badge.mjs
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sharp = createRequire(join(repoRoot, 'apps/desktop/package.json'))('sharp')
const outputPath = join(repoRoot, 'crates/memry-desktop/assets/pdf-badge.webp')

const width = 160
const height = 200
const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" rx="8" fill="#DC2626"/>
    <text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle"
          font-family="sans-serif" font-size="36" font-weight="bold" fill="white">PDF</text>
    <text x="50%" y="70%" dominant-baseline="middle" text-anchor="middle"
          font-family="sans-serif" font-size="11" fill="rgba(255,255,255,0.8)">Document</text>
  </svg>`

const result = await sharp(Buffer.from(svg))
  .webp({ quality: 80 })
  .toBuffer({ resolveWithObject: true })
if (result.info.width !== width || result.info.height !== height) {
  throw new Error(
    `badge is ${result.info.width}x${result.info.height}, expected ${width}x${height}`
  )
}
writeFileSync(outputPath, result.data)
console.log(`wrote ${outputPath} (${result.data.byteLength} bytes)`)
