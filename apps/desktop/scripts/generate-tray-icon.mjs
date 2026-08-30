// Regenerates src/main/tray-icon.ts from the shipped brand mark.
//
// Source is favicon.svg, the bare mark, not build/icon.png: the app icon is a
// rounded-square tile whose alpha is the tile, so a macOS template image made
// from it is a solid black blob rather than the mark.
//
// The result is embedded as base64 rather than read from disk because
// electron-builder excludes `directories.buildResources` (build/) from the
// packaged app — app-builder-lib pushes `!build{,/**/*}` into the file
// patterns — so nothing under build/ exists at runtime in a release build.
//
// Usage: node apps/desktop/scripts/generate-tray-icon.mjs

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(desktopDir, '..', 'landing', 'public', 'favicon.svg')
const TARGET = join(desktopDir, 'src', 'main', 'tray-icon.ts')
const SIZE = 32
const DENSITY = 512
// 1pt of clear space at the macOS menu bar's 16pt slot, so the mark is not
// flush against the status items on either side of it.
const PADDING = 2

async function renderColor(source) {
  return sharp(source, { density: DENSITY })
    .resize(SIZE - PADDING * 2, SIZE - PADDING * 2, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .extend({
      top: PADDING,
      bottom: PADDING,
      left: PADDING,
      right: PADDING,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

// macOS template images are alpha-only silhouettes: the system recolours them
// for light/dark menu bars. Keep the mark's alpha, force every colour channel
// to black.
async function renderTemplate(source) {
  const { data, info } = await sharp(source, { density: DENSITY })
    .resize(SIZE - PADDING * 2, SIZE - PADDING * 2, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .extend({
      top: PADDING,
      bottom: PADDING,
      left: PADDING,
      right: PADDING,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  for (let i = 0; i < data.length; i += info.channels) {
    data[i] = 0
    data[i + 1] = 0
    data[i + 2] = 0
  }

  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

async function assertDecodes(label, buffer) {
  const meta = await sharp(buffer).metadata()
  if (meta.format !== 'png' || meta.width !== SIZE || meta.height !== SIZE) {
    throw new Error(
      `${label}: expected a ${SIZE}x${SIZE} png, got ${meta.format} ${meta.width}x${meta.height}`
    )
  }
  console.log(`${label}: ${meta.width}x${meta.height} png, ${buffer.length} bytes`)
}

const source = await readFile(SOURCE)
const color = await renderColor(source)
const template = await renderTemplate(source)
await assertDecodes('color', color)
await assertDecodes('template', template)

const file = `// GENERATED FILE — do not edit by hand.
// Regenerate with: node apps/desktop/scripts/generate-tray-icon.mjs
//
// ${SIZE}x${SIZE} PNGs rendered from apps/landing/public/favicon.svg, the bare
// brand mark. They are inlined rather than loaded from disk because
// electron-builder drops the buildResources directory from the packaged app, so
// nothing under apps/desktop/build exists at runtime in a release build.

/** Full-colour mark, for Windows and Linux tray hosts. */
export const TRAY_ICON_BASE64 =
  '${color.toString('base64')}'

/** Alpha-only silhouette of the same mark, for the macOS menu bar. */
export const TRAY_ICON_TEMPLATE_BASE64 =
  '${template.toString('base64')}'
`

await writeFile(TARGET, file)
console.log(`wrote ${TARGET}`)

await writeFile('/tmp/tray-preview-color.png', color)
await writeFile('/tmp/tray-preview-template.png', template)
