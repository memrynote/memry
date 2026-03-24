import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUILD_DIR = join(__dirname, '..', 'build')

const ICON_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1024" height="1024" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" rx="16" ry="16" fill="#1a1a1a"/>
  <g transform="translate(10, 10) scale(0.8)">
    <path d="M20 70 L20 30 L35 45 L50 25 L65 45 L80 30 L80 70 L50 70"
          stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M50 70 L50 85 L80 70"
          stroke="#FFFFFF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>
</svg>`

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
  return sharp(Buffer.from(ICON_SVG)).resize(size, size).png().toBuffer()
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

async function main() {
  mkdirSync(BUILD_DIR, { recursive: true })
  console.log('Generating app icons...')
  await Promise.all([generateIcns(), generateIco(), generatePng()])
  console.log('Done.')
}

main().catch((err) => {
  console.error('Icon generation failed:', err)
  process.exit(1)
})
