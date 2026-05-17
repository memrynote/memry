import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUILD_DIR = join(__dirname, '..', 'build')
const BRAND_DIR = join(__dirname, '..', '..', '..', 'assets', 'brand', 'memry')
const SOURCE_ICON_PATH = join(BRAND_DIR, 'icon-color.png')
const PROFILE_IMAGE_PATH = join(BRAND_DIR, 'social', 'profile-image.png')
const PROFILE_SQUARE_PATH = join(BRAND_DIR, 'social', 'profile-square.png')
const PROFILE_RECTANGLE_PATH = join(BRAND_DIR, 'social', 'profile-rectangle.png')
const CANVAS_SIZE = 1024
const PROFILE_RECTANGLE_WIDTH = 1500
const PROFILE_RECTANGLE_HEIGHT = 500
const TILE_INSET = 64
const TILE_SIZE = CANVAS_SIZE - TILE_INSET * 2
const TILE_RADIUS = 210
const LOGO_SIZE = 632
const LOGO_INSET = Math.round((CANVAS_SIZE - LOGO_SIZE) / 2)
const imageDataUris = new Map()

function getImageDataUri(imagePath) {
  let dataUri = imageDataUris.get(imagePath)
  if (!dataUri) {
    dataUri = `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`
    imageDataUris.set(imagePath, dataUri)
  }
  return dataUri
}

function renderIconSvg() {
  const sourceIcon = getImageDataUri(SOURCE_ICON_PATH)

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" viewBox="0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="512" y1="${TILE_INSET}" x2="512" y2="${CANVAS_SIZE - TILE_INSET}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fffdf8"/>
      <stop offset="1" stop-color="#f2eee6"/>
    </linearGradient>
    <linearGradient id="shine" x1="512" y1="${TILE_INSET}" x2="512" y2="430" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.72"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="0" y="0" width="1024" height="1024" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="18" stdDeviation="26" flood-color="#000000" flood-opacity="0.22"/>
    </filter>
    <filter id="logoDepth" x="${LOGO_INSET - 96}" y="${LOGO_INSET - 96}" width="${LOGO_SIZE + 192}" height="${LOGO_SIZE + 192}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="18" stdDeviation="16" flood-color="#8f2f05" flood-opacity="0.26"/>
      <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000000" flood-opacity="0.18"/>
    </filter>
    <linearGradient id="logoHighlight" x1="${LOGO_INSET}" y1="${LOGO_INSET}" x2="${LOGO_INSET}" y2="${LOGO_INSET + LOGO_SIZE}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="0.42" stop-color="#ffffff" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="logoShade" x1="${LOGO_INSET}" y1="${LOGO_INSET}" x2="${LOGO_INSET}" y2="${LOGO_INSET + LOGO_SIZE}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="0.58" stop-color="#5b1700" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#5b1700" stop-opacity="0.20"/>
    </linearGradient>
    <mask id="logoMask" maskUnits="userSpaceOnUse" x="${LOGO_INSET}" y="${LOGO_INSET}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" mask-type="alpha">
      <image href="${sourceIcon}" x="${LOGO_INSET}" y="${LOGO_INSET}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" preserveAspectRatio="xMidYMid meet"/>
    </mask>
  </defs>
  <rect x="${TILE_INSET}" y="${TILE_INSET}" width="${TILE_SIZE}" height="${TILE_SIZE}" rx="${TILE_RADIUS}" fill="url(#bg)" filter="url(#shadow)"/>
  <rect x="${TILE_INSET + 2}" y="${TILE_INSET + 2}" width="${TILE_SIZE - 4}" height="${TILE_SIZE - 4}" rx="${TILE_RADIUS - 2}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="4"/>
  <rect x="${TILE_INSET}" y="${TILE_INSET}" width="${TILE_SIZE}" height="${TILE_SIZE * 0.45}" rx="${TILE_RADIUS}" fill="url(#shine)"/>
  <g filter="url(#logoDepth)">
    <image href="${sourceIcon}" x="${LOGO_INSET}" y="${LOGO_INSET}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" preserveAspectRatio="xMidYMid meet"/>
    <rect x="${LOGO_INSET}" y="${LOGO_INSET}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" fill="url(#logoHighlight)" mask="url(#logoMask)"/>
    <rect x="${LOGO_INSET}" y="${LOGO_INSET}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" fill="url(#logoShade)" mask="url(#logoMask)"/>
  </g>
</svg>`
}

function renderProfileImageSvg() {
  return renderSocialProfileSvg({
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    logoSize: LOGO_SIZE
  })
}

function renderProfileRectangleSvg() {
  return renderSocialProfileSvg({
    width: PROFILE_RECTANGLE_WIDTH,
    height: PROFILE_RECTANGLE_HEIGHT,
    logoSize: 300
  })
}

function renderSocialProfileSvg({ width, height, logoSize }) {
  const sourceIcon = getImageDataUri(SOURCE_ICON_PATH)
  const logoInsetX = Math.round((width - logoSize) / 2)
  const logoInsetY = Math.round((height - logoSize) / 2)

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="${width / 2}" y1="0" x2="${width / 2}" y2="${height}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fffdf8"/>
      <stop offset="1" stop-color="#f2eee6"/>
    </linearGradient>
    <filter id="logoDepth" x="${logoInsetX - 96}" y="${logoInsetY - 96}" width="${logoSize + 192}" height="${logoSize + 192}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="18" stdDeviation="16" flood-color="#8f2f05" flood-opacity="0.26"/>
      <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#000000" flood-opacity="0.18"/>
    </filter>
    <linearGradient id="logoHighlight" x1="${logoInsetX}" y1="${logoInsetY}" x2="${logoInsetX}" y2="${logoInsetY + logoSize}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="0.42" stop-color="#ffffff" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="logoShade" x1="${logoInsetX}" y1="${logoInsetY}" x2="${logoInsetX}" y2="${logoInsetY + logoSize}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="0.58" stop-color="#5b1700" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#5b1700" stop-opacity="0.20"/>
    </linearGradient>
    <mask id="logoMask" maskUnits="userSpaceOnUse" x="${logoInsetX}" y="${logoInsetY}" width="${logoSize}" height="${logoSize}" mask-type="alpha">
      <image href="${sourceIcon}" x="${logoInsetX}" y="${logoInsetY}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>
    </mask>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <g filter="url(#logoDepth)">
    <image href="${sourceIcon}" x="${logoInsetX}" y="${logoInsetY}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>
    <rect x="${logoInsetX}" y="${logoInsetY}" width="${logoSize}" height="${logoSize}" fill="url(#logoHighlight)" mask="url(#logoMask)"/>
    <rect x="${logoInsetX}" y="${logoInsetY}" width="${logoSize}" height="${logoSize}" fill="url(#logoShade)" mask="url(#logoMask)"/>
  </g>
</svg>`
}

const ICONSET_SIZES = [
  { name: 'icon_16x16.png', size: 16 },
  { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 },
  { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 },
  { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 },
  { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 },
  { name: 'icon_512x512@2x.png', size: 1024 }
]

const ICO_SIZES = [16, 32, 48, 64, 128, 256]

async function renderPng(size) {
  return sharp(Buffer.from(renderIconSvg())).resize(size, size).png().toBuffer()
}

function buildIco(pngBuffers, sizes) {
  const headerSize = 6
  const dirEntrySize = 16
  const dirSize = dirEntrySize * pngBuffers.length
  let dataOffset = headerSize + dirSize

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngBuffers.length, 4)

  const dirEntries = []
  const offsets = []
  for (let i = 0; i < pngBuffers.length; i++) {
    offsets.push(dataOffset)
    dataOffset += pngBuffers[i].length
  }

  for (let i = 0; i < pngBuffers.length; i++) {
    const entry = Buffer.alloc(dirEntrySize)
    entry.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 0)
    entry.writeUInt8(sizes[i] >= 256 ? 0 : sizes[i], 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(pngBuffers[i].length, 8)
    entry.writeUInt32LE(offsets[i], 12)
    dirEntries.push(entry)
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers])
}

async function generateIcns() {
  if (process.platform !== 'darwin') {
    console.warn('  [skip] .icns generation requires macOS (iconutil)')
    return
  }

  const iconsetDir = join(BUILD_DIR, 'icon.iconset')
  mkdirSync(iconsetDir, { recursive: true })

  await Promise.all(
    ICONSET_SIZES.map(async ({ name, size }) => {
      const buf = await renderPng(size)
      writeFileSync(join(iconsetDir, name), buf)
    })
  )

  const output = join(BUILD_DIR, 'icon.icns')
  execFileSync('iconutil', ['-c', 'icns', '-o', output, iconsetDir])
  rmSync(iconsetDir, { recursive: true })
  console.log('  icon.icns')
}

async function generateIco() {
  const pngBuffers = await Promise.all(ICO_SIZES.map((s) => renderPng(s)))
  const ico = buildIco(pngBuffers, ICO_SIZES)
  writeFileSync(join(BUILD_DIR, 'icon.ico'), ico)
  console.log('  icon.ico')
}

async function generatePng() {
  const buf = await renderPng(1024)
  writeFileSync(join(BUILD_DIR, 'icon.png'), buf)
  console.log('  icon.png')
}

async function generateProfileImage() {
  mkdirSync(dirname(PROFILE_IMAGE_PATH), { recursive: true })
  const buf = await sharp(Buffer.from(renderProfileImageSvg())).png().toBuffer()
  writeFileSync(PROFILE_IMAGE_PATH, buf)
  writeFileSync(PROFILE_SQUARE_PATH, buf)
  console.log('  assets/brand/memry/social/profile-image.png')
  console.log('  assets/brand/memry/social/profile-square.png')
}

async function generateProfileRectangle() {
  mkdirSync(dirname(PROFILE_RECTANGLE_PATH), { recursive: true })
  const buf = await sharp(Buffer.from(renderProfileRectangleSvg())).png().toBuffer()
  writeFileSync(PROFILE_RECTANGLE_PATH, buf)
  console.log('  assets/brand/memry/social/profile-rectangle.png')
}

async function main() {
  mkdirSync(BUILD_DIR, { recursive: true })
  console.log('Generating app icons...')
  await Promise.all([
    generateIcns(),
    generateIco(),
    generatePng(),
    generateProfileImage(),
    generateProfileRectangle()
  ])
  console.log('Done.')
}

main().catch((err) => {
  console.error('Icon generation failed:', err)
  process.exit(1)
})
